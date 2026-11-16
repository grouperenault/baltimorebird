"""Baltimore Bird - Running generic analyses on chosen data.

An analysis declares its inputs; a run binds them to the datasets the user selected, executes
the analysis in the confined runner, and stores one report per execution with its provenance
(analysis, version, datasets, signal resolution, outcome). See
``.okf/roadmap/reporting-analyses.md``.

A run request is validated immediately, then queued (``services.dashboard.run_queue``): one
background thread executes queued analyses one at a time, and the run screen polls the queue to
follow progress. A running analysis cannot be interrupted yet.
"""

from __future__ import annotations

import copy
import logging
from typing import Any, Dict, List, Optional, Tuple

from flask import Blueprint, g, jsonify, request

from api.auth import feature_required, login_required
from api.scripts import (
    SANDBOX_AVAILABLE,
    SafetyError,
    _execute_recipe,
    analysis_summary,
    compile_and_format,
    find_inputs_block,
    load_script,
    save_script,
    validate_blocks,
)
from config import BASE_DIR, REPORTS_DIR
from core import utc_now_iso, validate_script_id
from services.dashboard import build_html_report
from services.dashboard.datasets import Dataset, Resolution, bind, get_dataset, list_datasets, resolve
from services.dashboard.inputs import MAX_MERGED_DATASETS, DeclaredSignal, parse_declared_signals
from services.dashboard.report_store import new_report_id, save_report
from services.dashboard.run_queue import JobContext, RunQueue

logger = logging.getLogger(__name__)

reporting_bp = Blueprint("reporting", __name__)

DATASETS_DIR = BASE_DIR / "data" / "default" / "datasets"
MAX_RUN_DATASETS = MAX_MERGED_DATASETS
# Decoupage des donnees, choisi a l'execution: une execution par jeu, ou une seule sur tous.
RUN_MODES = ("per_file", "merged")
DEFAULT_RUN_MODE = "per_file"

# Rapport de demonstration livre avec l'application: l'analyse DEMO d'origine executee sur les
# donnees de demo. La relancer sur ces donnees reecrit ce rapport au lieu d'en ajouter un.
DEMO_ANALYSIS_ID = "script_analyse_standard"
DEMO_DATASET_ID = "demo-synthetique"
DEMO_REPORT_ID = "demo"


class RunRequestError(Exception):
    """A run request that cannot proceed; carries the HTTP status and the JSON body."""

    def __init__(self, status: int, body: Dict[str, Any]) -> None:
        super().__init__(body.get("error", ""))
        self.status = status
        self.body = body


@reporting_bp.route("/api/reporting/datasets")
@login_required
def list_reporting_datasets():
    """Lists the datasets an analysis can run on."""
    return jsonify({"datasets": [dataset.summary() for dataset in list_datasets(DATASETS_DIR)]})


def _prepare(payload: Dict[str, Any]) -> Tuple[Dict, List[DeclaredSignal], List[Dataset], List[Resolution]]:
    """Load the analysis and datasets of a run request and resolve the declared inputs.

    Args:
        payload: ``{"analysis_id": str, "datasets": [str]}``.

    Returns:
        The analysis, its declared signals, the selected datasets and one resolution each.

    Raises:
        RunRequestError: On an unknown analysis or dataset, an invalid analysis, or a selection
            that does not fit the analysis.
    """
    analysis_id = payload.get("analysis_id")
    if not isinstance(analysis_id, str) or not validate_script_id(analysis_id):
        raise RunRequestError(400, {"error": "Identifiant d'analyse invalide"})
    script = load_script(analysis_id, g.current_user.id)
    if not script:
        raise RunRequestError(404, {"error": "Analyse introuvable"})

    valid, message = validate_blocks(script.get("blocks", []))
    if not valid:
        raise RunRequestError(400, {"error": f"Analyse invalide : {message}. Corrigez-la dans l'éditeur."})

    dataset_ids = payload.get("datasets") or []
    if not isinstance(dataset_ids, list) or not all(isinstance(item, str) for item in dataset_ids):
        raise RunRequestError(400, {"error": "La sélection de données doit être une liste d'identifiants"})
    if len(set(dataset_ids)) != len(dataset_ids):
        raise RunRequestError(400, {"error": "Un même jeu de données est sélectionné deux fois"})
    if len(dataset_ids) > MAX_RUN_DATASETS:
        raise RunRequestError(400, {"error": f"Trop de jeux de données (max {MAX_RUN_DATASETS})"})

    block = find_inputs_block(script)
    if block is None:
        if dataset_ids:
            raise RunRequestError(400, {
                "error": "Cette analyse contient ses propres données : elle ne prend pas de jeu de données en entrée."
            })
        return script, [], [], []

    declared = parse_declared_signals(block.get("config", {}).get("signals"))
    if not dataset_ids:
        raise RunRequestError(400, {"error": "Sélectionnez au moins un jeu de données"})
    datasets: List[Dataset] = []
    for dataset_id in dataset_ids:
        dataset = get_dataset(DATASETS_DIR, dataset_id)
        if dataset is None:
            raise RunRequestError(404, {"error": f"Jeu de données introuvable : {dataset_id}"})
        datasets.append(dataset)
    return script, declared, datasets, [resolve(declared, dataset) for dataset in datasets]


@reporting_bp.route("/api/reporting/preflight", methods=["POST"])
@login_required
def preflight_run():
    """Shows how the inputs of an analysis resolve on a dataset selection, without running."""
    try:
        script, declared, datasets, resolutions = _prepare(request.get_json(silent=True) or {})
    except RunRequestError as exc:
        return jsonify({"success": False, **exc.body}), exc.status
    return jsonify({
        "success": True,
        **analysis_summary(script),
        "resolutions": [resolution.as_dict() for resolution in resolutions],
        "runnable": all(resolution.complete for resolution in resolutions),
        "datasets": [dataset.summary() for dataset in datasets],
        "declared": [{"name": signal.name, "unit": signal.unit} for signal in declared],
    })


def _run_groups(mode: str, datasets: List[Dataset], resolutions: List[Resolution]) -> List[List[int]]:
    """Indices of the datasets feeding each execution: one each per file, all together merged."""
    if not datasets:
        return [[]]
    if mode == "merged":
        return [list(range(len(datasets)))]
    return [[index] for index in range(len(datasets))]


def _input_entry(dataset: Dataset, resolution: Resolution) -> Dict[str, Any]:
    return {
        "dataset_id": dataset.id,
        "name": dataset.name,
        "kind": "synthetic",
        "hash": dataset.content_hash,
        "matched": dict(resolution.matched),
        "unit_mismatches": list(resolution.unit_mismatches),
    }


def _report_id_for(script: Dict, dataset_ids: List[str]) -> str:
    """Identifier of the report a run writes: the fixed demo report, or a new one."""
    is_demo = (
        script.get("id") == DEMO_ANALYSIS_ID
        and script.get("_readonly")
        and dataset_ids == [DEMO_DATASET_ID]
    )
    if is_demo:
        return DEMO_REPORT_ID
    return new_report_id(str(script.get("name") or script.get("id")))


def _execute_group(script: Dict, analysis_hash: str, mode: str, declared: List[DeclaredSignal],
                   group: List[Tuple[Dataset, Resolution]], user_id: str) -> Dict[str, Any]:
    """Run the analysis on one group of datasets and store its report.

    Runs in the queue thread: no request context, the user is passed explicitly.

    Returns:
        The run summary returned to the client, including the stored report identifier.
    """
    script_id = str(script.get("id"))
    bindings = [bind(declared, dataset, resolution) for dataset, resolution in group] or None
    inputs = [_input_entry(dataset, resolution) for dataset, resolution in group]
    try:
        outcome = _execute_recipe(script, script_id, bindings)
    except SafetyError as exc:
        logger.warning("Run refused by the safety check: analysis=%s errors=%s", script_id, exc.errors)
        return {"status": "failed", "error": "Code généré non sécurisé", "inputs": inputs, "report_id": None}

    provenance = dict(outcome["provenance"])
    provenance.update({"analysis_hash": analysis_hash, "mode": mode, "inputs": inputs})
    html = build_html_report(script, outcome["document"], provenance)
    report_id = _report_id_for(script, [dataset.id for dataset, _ in group])
    meta = {
        "kind": "analysis_run",
        "analysis": {
            "id": script_id,
            "name": str(script.get("name") or script_id),
            "hash": analysis_hash,
            "version": script.get("version", 1),
        },
        "mode": mode,
        "inputs": inputs,
        "status": outcome["status"],
        "duration": outcome["duration"],
        "module_hash": provenance.get("module_hash"),
        "block_errors": outcome["block_errors"],
        "created": utc_now_iso(),
    }
    save_report(REPORTS_DIR, report_id, html, meta)
    # Journal d'execution (PER-05): utilisateur, versions, donnees, duree, issue.
    logger.info(
        "Analysis run: user=%s analysis=%s analysis_hash=%s module_hash=%s datasets=%s status=%s"
        " duration=%ss report=%s",
        user_id, script_id, analysis_hash, provenance.get("module_hash"),
        ",".join(entry["dataset_id"] for entry in inputs) or "-", outcome["status"], outcome["duration"], report_id,
    )
    return {
        "status": outcome["status"],
        "duration": outcome["duration"],
        "error": outcome.get("error"),
        "block_errors": outcome["block_errors"],
        "inputs": inputs,
        "report_id": report_id,
    }


def _execute_plan(plan: Dict[str, Any], ctx: JobContext) -> Dict[str, Any]:
    """Queue executor: run every execution of a job, logging progress as it goes."""
    groups = plan["groups"]
    runs: List[Dict[str, Any]] = []
    for index, group in enumerate(groups, start=1):
        names = ", ".join(dataset.name for dataset, _ in group) or "données intégrées"
        ctx.log(f"Exécution {index}/{len(groups)} sur « {names} »")
        run = _execute_group(plan["script"], plan["analysis_hash"], plan["mode"], plan["declared"], group, ctx.user_id)
        runs.append(run)
        _log_run_outcome(ctx, run)
        ctx.progress(index)
    _record_last_run(plan["script"], runs, ctx.user_id)
    produced = sum(1 for run in runs if run.get("report_id"))
    ctx.log(f"Terminée : {produced} rapport(s) produit(s)", "success" if produced == len(runs) else "warning")
    return {"mode": plan["mode"], "runs": runs}


_STATUS_LOG = {
    "succeeded": ("Réussie", "success"),
    "partial": ("Partielle", "warning"),
    "failed": ("Échec", "error"),
}


def _log_run_outcome(ctx: JobContext, run: Dict[str, Any]) -> None:
    label, level = _STATUS_LOG.get(run["status"], (run["status"], "info"))
    duration = f" en {run['duration']} s" if run.get("duration") is not None else ""
    ctx.log(f"{label}{duration}", level)
    for block_id, message in (run.get("block_errors") or {}).items():
        ctx.log(f"Bloc {block_id} : {message}", "error")
    if run.get("error") and not run.get("report_id"):
        ctx.log(str(run["error"]), "error")


RUN_QUEUE = RunQueue(_execute_plan)


@reporting_bp.route("/api/reporting/runs", methods=["POST"])
@feature_required("run_scripts")
def run_analysis():
    """Validates a run request, then queues it. The response does not wait for the execution."""
    if not SANDBOX_AVAILABLE:
        return jsonify({"success": False, "error": "Exécution d'analyses non disponible sur ce serveur"}), 503
    try:
        script, declared, datasets, resolutions = _prepare(request.get_json(silent=True) or {})
    except RunRequestError as exc:
        return jsonify({"success": False, **exc.body}), exc.status

    incomplete = [resolution.as_dict() for resolution in resolutions if not resolution.complete]
    if incomplete:
        return jsonify({
            "success": False,
            "error": "Des signaux déclarés par l'analyse sont absents des données sélectionnées",
            "resolutions": incomplete,
        }), 400

    payload = request.get_json(silent=True) or {}
    mode = payload.get("mode") or DEFAULT_RUN_MODE
    if mode not in RUN_MODES:
        return jsonify({"success": False, "error": "Mode d'exécution inconnu (par fichier ou fusionné)"}), 400
    if len(datasets) <= 1:
        mode = DEFAULT_RUN_MODE
    try:
        analysis_hash = compile_and_format(script).provenance_hash
    except ValueError as exc:
        return jsonify({"success": False, "error": f"Analyse invalide : {exc}"}), 400

    groups = [
        [(datasets[index], resolutions[index]) for index in indices]
        for indices in _run_groups(mode, datasets, resolutions)
    ]
    name = str(script.get("name") or script.get("id"))
    plan = {
        # Copie figee au lancement: modifier l'analyse pendant l'attente ne change pas ce run (LIF-03).
        "script": copy.deepcopy(script),
        "analysis_hash": analysis_hash,
        "mode": mode,
        "declared": declared,
        "groups": groups,
    }
    summary = {
        "analysis": {"id": script.get("id"), "name": name},
        "mode": mode,
        "datasets": [{"id": dataset.id, "name": dataset.name} for dataset in datasets],
    }
    try:
        job = RUN_QUEUE.submit(g.current_user.id, name, plan, summary, total=len(groups))
    except ValueError as exc:
        return jsonify({"success": False, "error": str(exc).capitalize()}), 429
    return jsonify({"success": True, "job": job}), 202


@reporting_bp.route("/api/reporting/jobs")
@login_required
def list_jobs():
    """The current user's queued, running and recent runs, with their logs."""
    return jsonify({"jobs": RUN_QUEUE.list(g.current_user.id)})


@reporting_bp.route("/api/reporting/jobs/<job_id>")
@login_required
def get_job(job_id: str):
    """One run of the current user."""
    job = RUN_QUEUE.get(g.current_user.id, job_id)
    if job is None:
        return jsonify({"error": "Exécution introuvable"}), 404
    return jsonify({"job": job})


@reporting_bp.route("/api/reporting/jobs/<job_id>/cancel", methods=["POST"])
@login_required
def cancel_job(job_id: str):
    """Removes a run that has not started yet."""
    job = RUN_QUEUE.cancel(g.current_user.id, job_id)
    if job is None:
        return jsonify({"error": "Seule une exécution encore en attente peut être retirée"}), 409
    return jsonify({"job": job})


def _record_last_run(script: Dict, runs: List[Dict[str, Any]], user_id: str) -> None:
    """Store the outcome of the latest run on the analysis, when the user owns it.

    The analysis is reloaded: the plan holds a copy taken at submission, and writing it back
    would undo edits made while the run waited in the queue.
    """
    if script.get("_readonly") or script.get("_owner") != user_id or not runs:
        return
    current = load_script(str(script.get("id")), user_id)
    if not current or current.get("_readonly"):
        return
    statuses = {run["status"] for run in runs}
    worst: Optional[str] = next((s for s in ("failed", "partial") if s in statuses), "succeeded")
    current["lastRun"] = utc_now_iso()
    current["lastRunStatus"] = worst
    current["lastRunDuration"] = round(sum(run.get("duration") or 0 for run in runs), 3)
    try:
        save_script(current, user_id)
    except ValueError as exc:
        logger.warning("Last run not recorded on analysis %s: %s", script.get("id"), exc)
