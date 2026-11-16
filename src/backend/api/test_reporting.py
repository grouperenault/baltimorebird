"""Runs of generic analyses on chosen datasets (/api/reporting/*).

Exécution : python -m pytest api/test_reporting.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from flask import Flask

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import api.auth as auth_module  # noqa: E402
import api.reporting as reporting_module  # noqa: E402
import api.reports as reports_module  # noqa: E402
import api.scripts as scripts_module  # noqa: E402
from services.dashboard.run_queue import RunQueue  # noqa: E402
from services.dashboard.test_inputs import DATASETS_DIR, write_test_datasets  # noqa: E402

USER_ID = "4f1c2a3b-5d6e-4f70-8a9b-0c1d2e3f4a5b"
DEMO = "script_analyse_standard"
DEMO_SIGNALS = ("vehicle_speed", "engine_rpm", "coolant_temp", "brake_pressure")


@pytest.fixture
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """App with the reporting and reports blueprints, a logged-in user and temporary storage."""
    user = SimpleNamespace(id=USER_ID, role="user", is_active=True)
    monkeypatch.setattr(auth_module, "get_current_user", lambda: user)
    monkeypatch.setattr(scripts_module, "USERS_SCRIPTS_DIR", tmp_path / "users")
    reports_dir = tmp_path / "reports"
    reports_dir.mkdir()
    monkeypatch.setattr(reporting_module, "REPORTS_DIR", reports_dir)
    monkeypatch.setattr(reporting_module, "DATASETS_DIR", write_test_datasets(tmp_path / "datasets"))
    monkeypatch.setattr(reports_module, "REPORTS_DIR", reports_dir)
    # File sans fil de fond: le test declenche l'execution, deterministe.
    queue = RunQueue(reporting_module._execute_plan, start_thread=False)
    monkeypatch.setattr(reporting_module, "RUN_QUEUE", queue)
    flask_app = Flask(__name__)
    flask_app.register_blueprint(reporting_module.reporting_bp)
    flask_app.register_blueprint(reports_module.reports_bp)
    return SimpleNamespace(client=flask_app.test_client(), reports_dir=reports_dir, queue=queue)


def _run(env, payload: dict) -> dict:
    """Queue a run, execute the queue, and return the finished job's result."""
    response = env.client.post("/api/reporting/runs", json=payload)
    assert response.status_code == 202, response.get_json()
    job_id = response.get_json()["job"]["id"]
    env.queue.run_pending()
    job = env.client.get(f"/api/reporting/jobs/{job_id}").get_json()["job"]
    assert job["state"] == "done", job
    assert job["done"] == job["total"]
    return job["result"]


def _save_user_analysis(analysis_id: str) -> None:
    recipe = scripts_module.load_script(DEMO)
    recipe = {key: value for key, value in recipe.items() if not key.startswith("_")}
    recipe["id"] = analysis_id
    scripts_module.save_script(recipe, USER_ID)


def test_datasets_are_listed_without_generator_parameters(env) -> None:
    datasets = env.client.get("/api/reporting/datasets").get_json()["datasets"]
    first = next(item for item in datasets if item["id"] == "demo-synthetique")
    assert {"name": "brake_pressure", "unit": "bar"} in first["signals"]
    assert "seed" not in first


def test_preflight_shows_what_each_dataset_lacks(env) -> None:
    body = env.client.post("/api/reporting/preflight", json={
        "analysis_id": DEMO, "datasets": ["demo-synthetique", "autre-logger"],
    }).get_json()
    assert body["runnable"] is False
    assert "mode" not in body
    complete, partial = body["resolutions"]
    assert complete["complete"] and complete["missing"] == []
    assert partial["missing"] == list(DEMO_SIGNALS)


def test_per_file_run_stores_one_report_per_dataset(env) -> None:
    body = _run(env, {"analysis_id": DEMO, "datasets": ["demo-synthetique", "demo-bis"]})
    assert [run["status"] for run in body["runs"]] == ["succeeded", "succeeded"]
    assert [run["inputs"][0]["dataset_id"] for run in body["runs"]] == ["demo-synthetique", "demo-bis"]

    report_id = body["runs"][0]["report_id"]
    meta = json.loads((env.reports_dir / f"{report_id}.json").read_text(encoding="utf-8"))
    assert meta["analysis"]["id"] == DEMO
    assert meta["mode"] == "per_file"
    assert meta["inputs"][0]["matched"] == {name: name for name in DEMO_SIGNALS}
    html = (env.reports_dir / f"{report_id}.html").read_text(encoding="utf-8")
    assert "Données de démo synthétiques" in html
    assert meta["analysis"]["hash"] in html

    listed = env.client.get("/api/reports").get_json()["reports"]
    assert {item["id"] for item in listed} == {run["report_id"] for run in body["runs"]}
    assert all(item["run"]["analysis"]["name"] == "Analyse standard (démo complète)" for item in listed)


def test_merged_run_stores_a_single_report_over_every_dataset(env) -> None:
    _save_user_analysis("script_demo_campagne")
    body = _run(env, {
        "analysis_id": "script_demo_campagne", "datasets": ["demo-synthetique", "demo-bis"], "mode": "merged",
    })
    assert body["mode"] == "merged"
    assert len(body["runs"]) == 1
    run = body["runs"][0]
    assert run["status"] == "succeeded", run
    assert [entry["dataset_id"] for entry in run["inputs"]] == ["demo-synthetique", "demo-bis"]
    saved = scripts_module.load_script("script_demo_campagne", USER_ID)
    assert saved["lastRunStatus"] == "succeeded"


def test_run_is_refused_when_a_declared_signal_is_missing(env) -> None:
    response = env.client.post("/api/reporting/runs", json={
        "analysis_id": DEMO, "datasets": ["autre-logger"],
    })
    assert response.status_code == 400
    assert response.get_json()["resolutions"][0]["dataset_id"] == "autre-logger"
    assert list(env.reports_dir.iterdir()) == []


def _save_self_contained_analysis() -> None:
    """An analysis saved before data moved to the run screen: it carries a synthetic source."""
    demo = json.loads((DATASETS_DIR / "demo-synthetique.json").read_text("utf-8"))
    recipe = {
        "id": "script_autonome",
        "name": "Analyse autonome",
        "blocks": [
            {"id": "b_src", "type": "synthetic_source", "config": {
                "name": "df", **{key: demo[key] for key in ("samples", "period", "seed", "signals")}}},
            {"id": "b_table", "type": "table", "config": {"source": "df", "caption": "Extrait", "max_rows": 5}},
        ],
    }
    scripts_module.save_script(recipe, USER_ID)


@pytest.mark.parametrize("payload, status", [
    ({"analysis_id": DEMO, "datasets": []}, 400),
    ({"analysis_id": DEMO, "datasets": ["../etc"]}, 404),
    ({"analysis_id": DEMO, "datasets": ["demo-synthetique", "demo-synthetique"]}, 400),
    ({"analysis_id": "script_autonome", "datasets": ["demo-synthetique"]}, 400),
    ({"analysis_id": "nope/../x", "datasets": []}, 400),
    ({"analysis_id": DEMO, "datasets": ["demo-synthetique", "demo-bis"], "mode": "sideways"}, 400),
])
def test_invalid_selections_are_refused(env, payload, status) -> None:
    _save_self_contained_analysis()
    response = env.client.post("/api/reporting/runs", json=payload)
    assert response.status_code == status, response.get_json()
    assert response.get_json()["error"]


def test_self_contained_analysis_runs_without_datasets(env) -> None:
    _save_self_contained_analysis()
    body = _run(env, {"analysis_id": "script_autonome", "datasets": []})
    assert len(body["runs"]) == 1 and body["runs"][0]["inputs"] == []
    assert body["runs"][0]["report_id"]


def test_demo_run_rewrites_the_shipped_demo_report(env) -> None:
    payload = {"analysis_id": DEMO, "datasets": ["demo-synthetique"]}
    first = _run(env, payload)["runs"][0]
    second = _run(env, payload)["runs"][0]
    assert first["report_id"] == second["report_id"] == "demo"
    assert sorted(path.name for path in env.reports_dir.iterdir()) == ["demo.html", "demo.json"]


def test_other_runs_of_the_demo_analysis_add_new_reports(env) -> None:
    body = _run(env, {"analysis_id": DEMO, "datasets": ["demo-bis"]})
    assert body["runs"][0]["report_id"] != "demo"
    _save_user_analysis("script_demo_copie")
    copy = _run(env, {"analysis_id": "script_demo_copie", "datasets": ["demo-synthetique"]})
    assert copy["runs"][0]["report_id"] != "demo"


def test_runs_queue_and_execute_in_submission_order(env) -> None:
    first = env.client.post("/api/reporting/runs", json={"analysis_id": DEMO, "datasets": ["demo-bis"]}).get_json()
    second = env.client.post("/api/reporting/runs", json={
        "analysis_id": DEMO, "datasets": ["demo-synthetique", "demo-bis"],
    }).get_json()
    assert (first["job"]["position"], second["job"]["position"]) == (1, 2)
    assert second["job"]["total"] == 2 and second["job"]["state"] == "queued"
    assert list(env.reports_dir.iterdir()) == [], "queuing must not execute"

    env.queue.run_pending()
    jobs = env.client.get("/api/reporting/jobs").get_json()["jobs"]
    assert [job["state"] for job in jobs] == ["done", "done"]
    assert jobs[0]["started"] <= jobs[1]["started"]
    messages = [line["message"] for line in jobs[1]["log"]]
    assert messages[0].startswith("Ajoutée à la file")
    assert "Exécution 2/2 sur « Démo bis »" in messages
    assert messages[-1] == "Terminée : 2 rapport(s) produit(s)"


def test_a_queued_run_can_be_removed_but_not_a_finished_one(env) -> None:
    payload = {"analysis_id": DEMO, "datasets": ["demo-bis"]}
    job = env.client.post("/api/reporting/runs", json=payload).get_json()["job"]
    other = env.client.post("/api/reporting/runs", json=payload).get_json()["job"]
    cancelled = env.client.post(f"/api/reporting/jobs/{job['id']}/cancel").get_json()["job"]
    assert cancelled["state"] == "cancelled"
    assert env.client.get(f"/api/reporting/jobs/{other['id']}").get_json()["job"]["position"] == 1

    env.queue.run_pending()
    assert len([p for p in env.reports_dir.iterdir() if p.suffix == ".html"]) == 1
    assert env.client.post(f"/api/reporting/jobs/{other['id']}/cancel").status_code == 409


def test_jobs_are_private_to_their_owner(env, monkeypatch: pytest.MonkeyPatch) -> None:
    job = env.client.post("/api/reporting/runs", json={"analysis_id": DEMO, "datasets": ["demo-bis"]}).get_json()["job"]
    stranger = SimpleNamespace(id="9e8d7c6b-5a49-4382-9716-05f4e3d2c1b0", role="user", is_active=True)
    monkeypatch.setattr(auth_module, "get_current_user", lambda: stranger)
    assert env.client.get("/api/reporting/jobs").get_json()["jobs"] == []
    assert env.client.get(f"/api/reporting/jobs/{job['id']}").status_code == 404
    assert env.client.post(f"/api/reporting/jobs/{job['id']}/cancel").status_code == 409


def test_editing_an_analysis_while_it_waits_is_kept(env) -> None:
    _save_user_analysis("script_demo_edit")
    env.client.post("/api/reporting/runs", json={"analysis_id": "script_demo_edit", "datasets": ["demo-bis"]})
    edited = scripts_module.load_script("script_demo_edit", USER_ID)
    edited["name"] = "Renommée pendant l'attente"
    scripts_module.save_script(edited, USER_ID)

    env.queue.run_pending()
    saved = scripts_module.load_script("script_demo_edit", USER_ID)
    assert saved["name"] == "Renommée pendant l'attente"
    assert saved["lastRunStatus"] == "succeeded"


def test_mode_is_chosen_at_run_time_and_recorded(env) -> None:
    merged = _run(env, {"analysis_id": DEMO, "datasets": ["demo-synthetique", "demo-bis"], "mode": "merged"})
    meta = json.loads((env.reports_dir / f"{merged['runs'][0]['report_id']}.json").read_text(encoding="utf-8"))
    assert meta["mode"] == "merged"
    # One dataset: merging means nothing, the run is per file whatever was asked.
    single = _run(env, {"analysis_id": DEMO, "datasets": ["demo-bis"], "mode": "merged"})
    assert single["mode"] == "per_file"
