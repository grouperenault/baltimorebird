"""Baltimore Bird - Declared inputs of a generic analysis.

An analysis no longer carries its data. Its ``inputs`` block declares the signals it needs, one
per line as ``<signal name> [unit]``, under a single variable name (``MAP-01``). The data is
chosen at run time: the run binds every declared signal to a column of the selected datasets,
then the analysis is compiled against that binding.

The generated module stays self-contained: a bound input renders numpy code producing exactly
the declared columns, published under their declared names. Without a binding (editor preview),
the input renders placeholder waveforms with the declared names, so the module compiles and can
be read before any data is chosen.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple

from .synthetic import MAX_SAMPLES, MAX_SIGNALS, SyntheticSignal, _render_signal_numpy

INPUTS_BLOCK_TYPE = "inputs"
SOURCE_INDEX_COLUMN = "source_index"
RESERVED_COLUMNS = ("time", SOURCE_INDEX_COLUMN)
MAX_SIGNAL_NAME_LENGTH = 200
MAX_MERGED_DATASETS = 16

PREVIEW_SAMPLES = 1000
PREVIEW_PERIOD = 0.01


@dataclass(frozen=True)
class DeclaredSignal:
    """A signal an analysis needs.

    Attributes:
        name: Exact signal name looked up in the input data, and column name in the frame.
        unit: Expected physical unit; informative, compared with the data at preflight.
    """

    name: str
    unit: str = ""


@dataclass(frozen=True)
class DatasetBinding:
    """The columns one dataset contributes to a run.

    Attributes:
        dataset_id: Identifier of the bound dataset.
        samples: Sample count of the dataset.
        period: Sampling period in seconds.
        seed: Dataset seed.
        columns: ``(declared name, dataset signal)`` pairs, in declaration order.
    """

    dataset_id: str
    samples: int
    period: float
    seed: int
    columns: Tuple[Tuple[str, SyntheticSignal], ...]


def parse_declared_signals(text: Any) -> List[DeclaredSignal]:
    """Parse the ``signals`` field of an inputs block.

    One signal per line: the name, then optionally its unit after whitespace. Blank lines are
    ignored.

    Args:
        text: Raw field value.

    Returns:
        Declared signals in line order.

    Raises:
        ValueError: On an empty declaration, a duplicate, a reserved or overlong name, or too
            many signals.
    """
    signals: List[DeclaredSignal] = []
    seen: set = set()
    for raw in str(text or "").replace("\r\n", "\n").split("\n"):
        parts = raw.split(None, 1)
        if not parts:
            continue
        name = parts[0]
        unit = parts[1].strip() if len(parts) > 1 else ""
        if len(name) > MAX_SIGNAL_NAME_LENGTH:
            raise ValueError(f"signal name too long (max {MAX_SIGNAL_NAME_LENGTH} characters): {name[:40]!r}...")
        if name in RESERVED_COLUMNS:
            raise ValueError(f"signal name {name!r} is reserved")
        if name in seen:
            raise ValueError(f"signal {name!r} is declared twice")
        seen.add(name)
        signals.append(DeclaredSignal(name=name, unit=unit))
    if not signals:
        raise ValueError("declare at least one signal (one per line: name [unit])")
    if len(signals) > MAX_SIGNALS:
        raise ValueError(f"too many signals (max {MAX_SIGNALS})")
    return signals


def validate_inputs_config(config: Dict[str, Any], reserved_prefix: str) -> List[str]:
    """Statically validate an inputs block configuration.

    Args:
        config: Raw block configuration.
        reserved_prefix: Compiler-reserved identifier prefix, refused as a variable name.

    Returns:
        User-facing error messages; empty when valid.
    """
    errors: List[str] = []
    name = str(config.get("name", "")).strip()
    if not name:
        errors.append("missing required field 'name'")
    elif not name.isidentifier():
        errors.append(f"variable name must be a valid identifier, got {name!r}")
    elif name.startswith(reserved_prefix):
        errors.append(f"variable name must not start with the reserved prefix {reserved_prefix!r}")
    try:
        parse_declared_signals(config.get("signals"))
    except ValueError as exc:
        errors.append(str(exc))
    return errors


def preview_binding(declared: Sequence[DeclaredSignal]) -> DatasetBinding:
    """Placeholder binding used when no data is chosen yet (editor preview).

    Args:
        declared: Declared signals.

    Returns:
        A binding generating one plain sine per declared signal.
    """
    columns = tuple((signal.name, SyntheticSignal(name="preview", unit=signal.unit)) for signal in declared)
    return DatasetBinding(dataset_id="", samples=PREVIEW_SAMPLES, period=PREVIEW_PERIOD, seed=0, columns=columns)


def render_inputs_numpy(fn_name: str, bindings: Optional[Sequence[DatasetBinding]],
                        declared: Sequence[DeclaredSignal]) -> List[str]:
    """Render the helper functions producing an analysis input frame.

    Args:
        fn_name: Name of the function the block calls (a compiler-reserved identifier).
        bindings: One binding per dataset; several means a merged run. ``None`` or empty
            renders the preview placeholder.
        declared: Declared signals, for the preview placeholder.

    Returns:
        Module-level helper sources. The last one defines ``fn_name``, which returns a dict of
        column name to numpy array.

    Raises:
        ValueError: On too many datasets or an out-of-range binding.
    """
    if not bindings:
        return [_render_binding(fn_name, preview_binding(declared))]
    if len(bindings) == 1:
        return [_render_binding(fn_name, bindings[0])]
    if len(bindings) > MAX_MERGED_DATASETS:
        raise ValueError(f"too many datasets in one merged run (max {MAX_MERGED_DATASETS})")
    helpers = [_render_binding(f"{fn_name}_{index}", binding) for index, binding in enumerate(bindings)]
    parts = ", ".join(f"{fn_name}_{index}()" for index in range(len(bindings)))
    helpers.append("\n".join([
        f"def {fn_name}() -> dict:",
        "    # Merged run: datasets stacked in selection order, origin kept in a dedicated column.",
        f"    parts = [{parts}]",
        "    columns = {}",
        "    for key in parts[0]:",
        "        columns[key] = np.concatenate([part[key] for part in parts])",
        f"    columns[{SOURCE_INDEX_COLUMN!r}] = np.concatenate(",
        "        [np.full(part['time'].shape, index, dtype=np.int32) for index, part in enumerate(parts)]",
        "    )",
        "    return columns",
        "",
    ]))
    return helpers


def _render_binding(fn_name: str, binding: DatasetBinding) -> str:
    if not 1 <= binding.samples <= MAX_SAMPLES:
        raise ValueError(f"samples must be in [1, {MAX_SAMPLES}], got {binding.samples}")
    lines: List[str] = [f"def {fn_name}() -> dict:"]
    if binding.dataset_id:
        lines.append(f"    # dataset: {binding.dataset_id}")
    else:
        lines.append("    # preview data: no dataset is bound outside a run")
    lines.append(f"    time = np.arange({binding.samples}, dtype=np.float64) * {binding.period!r}")
    lines.append("    columns = {\"time\": time}")
    for column, signal in binding.columns:
        lines.extend(_render_signal_numpy(signal, binding.seed, column=column))
    lines.append("    return columns")
    lines.append("")
    return "\n".join(lines)
