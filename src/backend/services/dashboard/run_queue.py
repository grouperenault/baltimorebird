"""Baltimore Bird - Queue of analysis runs.

Runs are queued and executed one at a time by a single background thread, in the process
memory of the one gunicorn worker (``.okf/decisions/0002-single-gunicorn-worker.md``). Each
job keeps its progress and a short log, which the run screen polls to follow the queue.

The queue knows nothing about analyses: a job carries an opaque plan and the queue hands it to
the executor given at construction. The executor reports progress and log lines through the
:class:`JobContext` it receives, and returns the job result.

Jobs live in memory only: a server restart drops the queue. Reports already produced are files
and survive.
"""

from __future__ import annotations

import logging
import threading
import uuid
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Deque, Dict, List, Optional

logger = logging.getLogger(__name__)

QUEUED = "queued"
RUNNING = "running"
DONE = "done"
FAILED = "failed"
CANCELLED = "cancelled"
ACTIVE_STATES = (QUEUED, RUNNING)

MAX_ACTIVE_JOBS_PER_USER = 20
MAX_KEPT_JOBS_PER_USER = 50
MAX_LOG_LINES = 200


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass
class Job:
    """One queued run.

    Attributes:
        id: Opaque identifier.
        user_id: Owner; only the owner sees or cancels the job.
        label: Human description shown in the queue (analysis name).
        plan: Opaque payload handed to the executor.
        summary: Public, JSON-serialisable description (analysis, datasets, mode).
        total: Number of executions the job will perform.
    """

    id: str
    user_id: str
    label: str
    plan: Any
    summary: Dict[str, Any]
    total: int
    state: str = QUEUED
    done: int = 0
    created: str = field(default_factory=_now)
    started: Optional[str] = None
    finished: Optional[str] = None
    result: Any = None
    error: Optional[str] = None
    log: List[Dict[str, str]] = field(default_factory=list)

    def public(self, position: Optional[int]) -> Dict[str, Any]:
        """JSON view of the job for its owner."""
        return {
            "id": self.id,
            "label": self.label,
            "state": self.state,
            "position": position,
            "done": self.done,
            "total": self.total,
            "created": self.created,
            "started": self.started,
            "finished": self.finished,
            "result": self.result,
            "error": self.error,
            "log": list(self.log),
            **self.summary,
        }


class JobContext:
    """Handle an executor uses to report on the job it runs."""

    def __init__(self, queue: "RunQueue", job: Job) -> None:
        self._queue = queue
        self._job = job

    @property
    def user_id(self) -> str:
        """Owner of the running job."""
        return self._job.user_id

    def log(self, message: str, level: str = "info") -> None:
        """Append a line to the job log (``info``, ``success``, ``warning`` or ``error``)."""
        self._queue._append_log(self._job, message, level)

    def progress(self, done: int) -> None:
        """Record how many of the job's executions are finished."""
        with self._queue._lock:
            self._job.done = done


Executor = Callable[[Any, JobContext], Any]


class RunQueue:
    """FIFO of jobs executed sequentially by one daemon thread, started on first use."""

    def __init__(self, executor: Executor, start_thread: bool = True) -> None:
        """Create a queue.

        Args:
            executor: Called with ``(plan, context)`` for each job, in submission order.
            start_thread: Start the background worker on first submission. Tests pass False
                and drive execution with :meth:`run_pending`; doing both would run two jobs
                at once.
        """
        self._executor = executor
        self._start_thread = start_thread
        self._lock = threading.Lock()
        self._wakeup = threading.Condition(self._lock)
        self._pending: Deque[str] = deque()
        self._jobs: Dict[str, Job] = {}
        self._thread: Optional[threading.Thread] = None

    # ------------------------------------------------------------------ submission

    def submit(self, user_id: str, label: str, plan: Any, summary: Dict[str, Any], total: int) -> Dict[str, Any]:
        """Queue a job.

        Args:
            user_id: Owner.
            label: Description shown in the queue.
            plan: Payload for the executor.
            summary: Public description of the job.
            total: Number of executions planned.

        Returns:
            The public view of the queued job.

        Raises:
            ValueError: When the user already has too many queued or running jobs.
        """
        with self._lock:
            active = sum(1 for job in self._jobs.values() if job.user_id == user_id and job.state in ACTIVE_STATES)
            if active >= MAX_ACTIVE_JOBS_PER_USER:
                raise ValueError(f"trop d'exécutions en attente (max {MAX_ACTIVE_JOBS_PER_USER})")
            job = Job(id=uuid.uuid4().hex, user_id=user_id, label=label, plan=plan, summary=summary, total=total)
            self._jobs[job.id] = job
            self._pending.append(job.id)
            self._prune(user_id)
            self._ensure_thread()
            self._wakeup.notify()
        self._append_log(job, f"Ajoutée à la file ({total} exécution(s) prévue(s))")
        return self.get(user_id, job.id)

    def cancel(self, user_id: str, job_id: str) -> Optional[Dict[str, Any]]:
        """Remove a job that has not started yet.

        Returns:
            The cancelled job, or None when unknown, not owned, or no longer queued.
        """
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None or job.user_id != user_id or job.state != QUEUED:
                return None
            self._pending.remove(job_id)
            job.state = CANCELLED
            job.finished = _now()
        self._append_log(job, "Retirée de la file", "warning")
        return self.get(user_id, job_id)

    # ------------------------------------------------------------------ queries

    def get(self, user_id: str, job_id: str) -> Optional[Dict[str, Any]]:
        """Public view of one job of a user, or None."""
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None or job.user_id != user_id:
                return None
            return job.public(self._position(job))

    def list(self, user_id: str) -> List[Dict[str, Any]]:
        """Jobs of a user, oldest first."""
        with self._lock:
            jobs = [job for job in self._jobs.values() if job.user_id == user_id]
            return [job.public(self._position(job)) for job in jobs]

    def _position(self, job: Job) -> Optional[int]:
        """1-based rank among jobs waiting to start, or None once started."""
        if job.state != QUEUED:
            return None
        return list(self._pending).index(job.id) + 1

    # ------------------------------------------------------------------ execution

    def run_pending(self) -> None:
        """Run every queued job in the calling thread (used by the worker and by tests)."""
        while True:
            with self._lock:
                if not self._pending:
                    return
                job = self._jobs[self._pending.popleft()]
                job.state = RUNNING
                job.started = _now()
            self._run(job)

    def _run(self, job: Job) -> None:
        self._append_log(job, "Démarrage")
        try:
            result = self._executor(job.plan, JobContext(self, job))
        except Exception as exc:  # noqa: BLE001 - a job failure must never stop the queue
            logger.exception("Analysis job %s failed", job.id)
            with self._lock:
                job.state = FAILED
                job.error = "Erreur interne pendant l'exécution"
                job.finished = _now()
            self._append_log(job, f"Échec : {type(exc).__name__}", "error")
            return
        with self._lock:
            job.result = result
            job.state = DONE
            job.done = job.total
            job.finished = _now()

    def _ensure_thread(self) -> None:
        """Start the worker thread on first submission (caller holds the lock)."""
        if not self._start_thread or (self._thread is not None and self._thread.is_alive()):
            return
        self._thread = threading.Thread(target=self._loop, name="analysis-run-queue", daemon=True)
        self._thread.start()

    def _loop(self) -> None:
        while True:
            with self._lock:
                while not self._pending:
                    self._wakeup.wait()
            self.run_pending()

    # ------------------------------------------------------------------ bookkeeping

    def _append_log(self, job: Job, message: str, level: str = "info") -> None:
        with self._lock:
            job.log.append({"time": _now(), "level": level, "message": message})
            del job.log[:-MAX_LOG_LINES]

    def _prune(self, user_id: str) -> None:
        """Forget the oldest finished jobs of a user beyond the retention limit (caller holds the lock)."""
        finished = [job for job in self._jobs.values() if job.user_id == user_id and job.state not in ACTIVE_STATES]
        for job in finished[:-MAX_KEPT_JOBS_PER_USER] if len(finished) > MAX_KEPT_JOBS_PER_USER else []:
            del self._jobs[job.id]
