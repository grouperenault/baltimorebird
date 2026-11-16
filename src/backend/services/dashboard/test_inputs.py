"""Generic analyses: declared inputs, dataset catalogue, binding at run time, report store.

Exécution : python -m pytest services/dashboard/test_inputs.py
"""

from __future__ import annotations

import copy
import io
import json
from contextlib import redirect_stdout
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict

import numpy as np
import pytest

from services.dashboard import compile_recipe, validate_recipe
from services.dashboard.compiler import MODULE_RESULT_MARKER
from services.dashboard.datasets import bind, get_dataset, list_datasets, resolve
from services.dashboard.inputs import DeclaredSignal, parse_declared_signals
from services.dashboard.report_store import is_valid_report_id, new_report_id, read_meta, save_report
from services.dashboard.synthetic import generate_synthetic_frame
from services.sandbox import check_code_safety

ROOT = Path(__file__).resolve().parents[2]
DATASETS_DIR = ROOT / "data" / "default" / "datasets"
INPUT_FN = "_bb_input_block_inputs"
DEMO_SIGNALS = ["vehicle_speed", "engine_rpm", "coolant_temp", "brake_pressure"]
DEMO_DATASET = "demo-synthetique"


def _demo_analysis() -> Dict[str, Any]:
    path = ROOT / "data" / "default" / "scripts" / "script_analyse_standard.json"
    return json.loads(path.read_text(encoding="utf-8"))


def write_test_datasets(directory: Path) -> Path:
    """Write the demo dataset plus two variants into ``directory``, for multi-dataset cases.

    ``demo-bis`` has the demo signals with another seed; ``autre-logger`` names them differently.
    """
    directory.mkdir(parents=True, exist_ok=True)
    demo = json.loads((DATASETS_DIR / f"{DEMO_DATASET}.json").read_text(encoding="utf-8"))
    (directory / f"{DEMO_DATASET}.json").write_text(json.dumps(demo), encoding="utf-8")
    bis = dict(demo, name="Démo bis", seed=7, samples=1500)
    (directory / "demo-bis.json").write_text(json.dumps(bis), encoding="utf-8")
    other = dict(demo, name="Autre logger", signals=[dict(sig, name=f"{sig['name']}_raw") for sig in demo["signals"]])
    (directory / "autre-logger.json").write_text(json.dumps(other), encoding="utf-8")
    return directory


@pytest.fixture
def datasets_dir(tmp_path: Path) -> Path:
    return write_test_datasets(tmp_path / "datasets")


def _exec(source: str) -> Dict[str, Any]:
    """Execute a generated module with numpy/json injected; return its namespace and document."""
    namespace: Dict[str, Any] = {"np": np, "json": json}
    buffer = io.StringIO()
    with redirect_stdout(buffer):
        exec(source, namespace)  # noqa: S102 - test harness executes generated, statically-checked code
    output = buffer.getvalue()
    namespace["__document__"] = json.loads(output[output.rfind(MODULE_RESULT_MARKER) + len(MODULE_RESULT_MARKER):])
    return namespace


def _bindings(directory: Path, *dataset_ids: str):
    declared = parse_declared_signals(_demo_analysis()["blocks"][1]["config"]["signals"])
    result = []
    for dataset_id in dataset_ids:
        dataset = get_dataset(directory, dataset_id)
        result.append(bind(declared, dataset, resolve(declared, dataset)))
    return result


# --------------------------------------------------------------------------------------------
# Declaration
# --------------------------------------------------------------------------------------------


def test_declared_signals_parse_name_and_unit() -> None:
    assert parse_declared_signals("BMS_HVBattVolt V\n\n  Cell.Temp  deg C \nflag") == [
        DeclaredSignal("BMS_HVBattVolt", "V"),
        DeclaredSignal("Cell.Temp", "deg C"),
        DeclaredSignal("flag", ""),
    ]


@pytest.mark.parametrize("text, fragment", [
    ("", "at least one signal"),
    ("a V\na A", "declared twice"),
    ("time s", "reserved"),
    ("source_index", "reserved"),
])
def test_declared_signals_refuse_invalid_declarations(text: str, fragment: str) -> None:
    with pytest.raises(ValueError, match=fragment):
        parse_declared_signals(text)


def test_recipe_validation_refuses_a_second_inputs_block() -> None:
    recipe = _demo_analysis()
    recipe["blocks"].append(copy.deepcopy(recipe["blocks"][1]) | {"id": "block_inputs_2"})
    recipe["blocks"][-1]["config"]["name"] = "df2"
    messages = [error["message"] for error in validate_recipe(recipe)]
    assert "only one inputs block per analysis" in messages


def test_a_mode_left_in_an_older_analysis_is_ignored() -> None:
    recipe = _demo_analysis()
    recipe["settings"]["mode"] = "merged"
    assert validate_recipe(recipe) == []


def test_default_generic_analysis_is_valid() -> None:
    assert validate_recipe(_demo_analysis()) == []


# --------------------------------------------------------------------------------------------
# Compilation: preview and bound runs
# --------------------------------------------------------------------------------------------


def test_preview_compiles_without_data_and_runs() -> None:
    module = compile_recipe(_demo_analysis())
    assert "preview data: no dataset is bound outside a run" in module.source
    namespace = _exec(module.source)
    columns = namespace[INPUT_FN]()
    assert list(columns) == ["time", *DEMO_SIGNALS]
    assert all(item["kind"] not in ("error", "skipped") for item in namespace["__document__"]["document"])


def test_bound_run_reproduces_the_dataset_signals() -> None:
    module = compile_recipe(_demo_analysis(), _bindings(DATASETS_DIR, DEMO_DATASET))
    columns = _exec(module.source)[INPUT_FN]()
    reference = generate_synthetic_frame(get_dataset(DATASETS_DIR, DEMO_DATASET).config)
    assert list(columns) == ["time", *DEMO_SIGNALS]
    for name in ("time", *DEMO_SIGNALS):
        assert np.array_equal(columns[name], reference[name].to_numpy()), name


def test_only_declared_signals_reach_the_module(datasets_dir: Path) -> None:
    recipe = _demo_analysis()
    recipe["blocks"][1]["config"]["signals"] = "vehicle_speed km/h"
    for block in recipe["blocks"]:
        if block["type"] in ("metrics", "python") or block.get("config", {}).get("y") not in (None, "vehicle_speed"):
            block["type"], block["config"] = "text", {"content": "retire"}
    declared = parse_declared_signals("vehicle_speed km/h")
    dataset = get_dataset(datasets_dir, DEMO_DATASET)
    module = compile_recipe(recipe, [bind(declared, dataset, resolve(declared, dataset))])
    assert "'vehicle_speed'" in module.source
    assert "'engine_rpm'" not in module.source


def test_binding_changes_the_module_but_not_the_analysis_hash(datasets_dir: Path) -> None:
    preview = compile_recipe(_demo_analysis())
    run_a = compile_recipe(_demo_analysis(), _bindings(datasets_dir, DEMO_DATASET))
    run_b = compile_recipe(_demo_analysis(), _bindings(datasets_dir, "demo-bis"))
    assert len({preview.provenance_hash, run_a.provenance_hash, run_b.provenance_hash}) == 3
    assert compile_recipe(_demo_analysis()).provenance_hash == preview.provenance_hash


def test_merged_run_stacks_datasets_with_their_origin(datasets_dir: Path) -> None:
    module = compile_recipe(_demo_analysis(), _bindings(datasets_dir, DEMO_DATASET, "demo-bis"))
    columns = _exec(module.source)[INPUT_FN]()
    assert len(columns["time"]) == 3000 + 1500
    assert columns["source_index"].tolist() == [0] * 3000 + [1] * 1500
    reference_bis = generate_synthetic_frame(get_dataset(datasets_dir, "demo-bis").config)
    assert np.array_equal(columns["engine_rpm"][3000:], reference_bis["engine_rpm"].to_numpy())


def test_bound_modules_pass_the_sandbox_safety_check(datasets_dir: Path) -> None:
    single = _bindings(datasets_dir, DEMO_DATASET)
    merged = _bindings(datasets_dir, DEMO_DATASET, "demo-bis")
    for bindings in (None, single, merged):
        safety = check_code_safety(compile_recipe(_demo_analysis(), bindings).source)
        assert safety["safe"], safety["errors"]


# --------------------------------------------------------------------------------------------
# Dataset catalogue and resolution
# --------------------------------------------------------------------------------------------


def test_shipped_catalogue_holds_only_the_demo_dataset() -> None:
    assert [dataset.id for dataset in list_datasets(DATASETS_DIR)] == [DEMO_DATASET]


def test_demo_analysis_resolves_completely_on_the_demo_dataset() -> None:
    declared = parse_declared_signals(_demo_analysis()["blocks"][1]["config"]["signals"])
    resolution = resolve(declared, get_dataset(DATASETS_DIR, DEMO_DATASET))
    assert resolution.complete and resolution.unit_mismatches == []


def test_catalogue_refuses_identifiers_outside_the_pattern() -> None:
    assert get_dataset(DATASETS_DIR, "../scripts/script_analyse_standard") is None
    assert get_dataset(DATASETS_DIR, "DEMO") is None


def test_resolution_reports_missing_signals_and_unit_mismatches(datasets_dir: Path) -> None:
    declared = [DeclaredSignal("vehicle_speed", "m/s"), DeclaredSignal("engine_rpm", "rpm")]
    resolution = resolve(declared, get_dataset(datasets_dir, DEMO_DATASET))
    assert resolution.complete
    assert resolution.unit_mismatches == [{"signal": "vehicle_speed", "declared": "m/s", "found": "km/h"}]

    other = resolve(declared, get_dataset(datasets_dir, "autre-logger"))
    assert other.missing == ["vehicle_speed", "engine_rpm"]
    with pytest.raises(ValueError, match="lacks"):
        bind(declared, get_dataset(datasets_dir, "autre-logger"), other)


# --------------------------------------------------------------------------------------------
# Report store
# --------------------------------------------------------------------------------------------


def test_report_ids_are_filename_safe() -> None:
    report_id = new_report_id("Analyse ../batterie HT <x>", now=datetime(2026, 11, 15, 10, 0, tzinfo=timezone.utc))
    assert is_valid_report_id(report_id)
    assert report_id.startswith("analyse-batterie-ht-x-20261115-100000-")


def test_report_and_provenance_round_trip(tmp_path: Path) -> None:
    save_report(tmp_path, "rapport-1", "<html></html>", {"status": "succeeded"})
    assert (tmp_path / "rapport-1.html").read_text(encoding="utf-8") == "<html></html>"
    assert read_meta(tmp_path, "rapport-1") == {"status": "succeeded", "id": "rapport-1"}
    assert read_meta(tmp_path, "../rapport-1") is None
    with pytest.raises(ValueError):
        save_report(tmp_path, "../evil", "", {})


# --------------------------------------------------------------------------------------------
# Block to code lines
# --------------------------------------------------------------------------------------------


def test_every_block_has_its_lines_in_the_formatted_module() -> None:
    from services.dashboard.compiler import block_line_ranges
    from services.dashboard.formatting import format_module

    recipe = _demo_analysis()
    module = format_module(compile_recipe(recipe))
    ranges = block_line_ranges(module.source, module.block_functions)
    assert set(ranges) == {block["id"] for block in recipe["blocks"]}
    lines = module.source.splitlines()
    first, last = ranges["block_plot_speed"][0]
    assert lines[first - 1].startswith("def ") and first <= last
    # The inputs block owns its function and the data helper it calls.
    names = [lines[start - 1].split("(")[0] for start, _ in ranges["block_inputs"]]
    assert names == ["def _bb_input_block_inputs", "def _bb_block_block_inputs"]
