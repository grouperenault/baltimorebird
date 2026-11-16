"""File d'exécution des analyses.

Exécution : python -m pytest services/dashboard/test_run_queue.py
"""

from __future__ import annotations

import threading
import time
from typing import Any, List

import pytest

from services.dashboard.run_queue import MAX_ACTIVE_JOBS_PER_USER, JobContext, RunQueue

USER = "user-a"


def _recording_executor(seen: List[Any]):
    def execute(plan: Any, ctx: JobContext) -> Any:
        if plan == "boom":
            raise RuntimeError("secret internal detail")
        seen.append(plan)
        ctx.log(f"ran {plan}")
        ctx.progress(1)
        return {"plan": plan}
    return execute


def test_jobs_run_in_submission_order_and_report_their_result() -> None:
    seen: List[Any] = []
    queue = RunQueue(_recording_executor(seen), start_thread=False)
    first = queue.submit(USER, "A", "a", {}, total=1)
    queue.submit(USER, "B", "b", {}, total=1)
    queue.run_pending()
    assert seen == ["a", "b"]
    job = queue.get(USER, first["id"])
    assert job["state"] == "done" and job["result"] == {"plan": "a"} and job["position"] is None
    assert [line["message"] for line in job["log"]][-1] == "ran a"


def test_a_failing_job_does_not_stop_the_queue_nor_leak_its_error() -> None:
    seen: List[Any] = []
    queue = RunQueue(_recording_executor(seen), start_thread=False)
    failed = queue.submit(USER, "boom", "boom", {}, total=1)
    queue.submit(USER, "after", "after", {}, total=1)
    queue.run_pending()
    assert seen == ["after"]
    job = queue.get(USER, failed["id"])
    assert job["state"] == "failed"
    assert "secret" not in job["error"] and all("secret" not in line["message"] for line in job["log"])


def test_active_jobs_per_user_are_capped() -> None:
    queue = RunQueue(_recording_executor([]), start_thread=False)
    for index in range(MAX_ACTIVE_JOBS_PER_USER):
        queue.submit(USER, str(index), index, {}, total=1)
    with pytest.raises(ValueError):
        queue.submit(USER, "one too many", None, {}, total=1)
    queue.submit("user-b", "other user", None, {}, total=1)


def test_background_thread_executes_submitted_jobs() -> None:
    done = threading.Event()

    def execute(plan: Any, ctx: JobContext) -> Any:
        done.set()
        return plan

    queue = RunQueue(execute)
    job = queue.submit(USER, "threaded", "x", {}, total=1)
    assert done.wait(5), "the worker thread did not pick the job up"
    deadline = time.monotonic() + 5
    while queue.get(USER, job["id"])["state"] != "done" and time.monotonic() < deadline:
        time.sleep(0.01)
    assert queue.get(USER, job["id"])["state"] == "done"
