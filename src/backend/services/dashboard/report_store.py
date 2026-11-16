"""Baltimore Bird - Storage of the reports produced by analysis runs.

A run report is the standalone HTML file, plus a JSON sidecar of the same identifier holding
its provenance: which analysis, in which version, on which data, with which outcome. The
report library lists both; HTML files without a sidecar (uploaded reports) stay listed as is.

Reports are untrusted HTML: they are only ever served in an opaque-origin sandbox (SEC-16, see
``middleware.security``).
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

REPORT_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
MAX_META_SIZE = 256 * 1024
_SLUG_MAX_LENGTH = 40


def new_report_id(analysis_name: str, now: Optional[datetime] = None) -> str:
    """Build a unique, filename-safe report identifier.

    Args:
        analysis_name: Name of the analysis, used as a readable prefix.
        now: Creation time; defaults to the current UTC time.

    Returns:
        ``<slug>-<YYYYmmdd-HHMMSS>-<8 hex>``, matching :data:`REPORT_ID_PATTERN`.
    """
    stamp = (now or datetime.now(timezone.utc)).strftime("%Y%m%d-%H%M%S")
    slug = re.sub(r"[^a-z0-9]+", "-", analysis_name.lower()).strip("-")[:_SLUG_MAX_LENGTH].strip("-")
    return f"{slug or 'rapport'}-{stamp}-{uuid.uuid4().hex[:8]}"


def is_valid_report_id(report_id: Any) -> bool:
    """True when ``report_id`` can safely name a file of the report directory."""
    return isinstance(report_id, str) and bool(REPORT_ID_PATTERN.match(report_id))


def save_report(directory: Path, report_id: str, html: str, meta: Dict[str, Any]) -> None:
    """Write a report and its provenance sidecar.

    The sidecar is written first: a report never appears in the library without its provenance.

    Args:
        directory: Report directory.
        report_id: Identifier from :func:`new_report_id`.
        html: Standalone report.
        meta: JSON-serialisable provenance.

    Raises:
        ValueError: If the identifier is invalid.
    """
    if not is_valid_report_id(report_id):
        raise ValueError(f"invalid report id {report_id!r}")
    directory.mkdir(parents=True, exist_ok=True)
    payload = dict(meta, id=report_id)
    (directory / f"{report_id}.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    (directory / f"{report_id}.html").write_text(html, encoding="utf-8")


def read_meta(directory: Path, report_id: str) -> Optional[Dict[str, Any]]:
    """Read the provenance sidecar of a report.

    Args:
        directory: Report directory.
        report_id: Report identifier.

    Returns:
        The provenance, or None for a report without sidecar or with an unreadable one.
    """
    if not is_valid_report_id(report_id):
        return None
    path = directory / f"{report_id}.json"
    try:
        if not path.is_file() or path.stat().st_size > MAX_META_SIZE:
            return None
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("Report provenance unreadable %s: %s", path.name, exc)
        return None
    return data if isinstance(data, dict) else None


def delete_meta(directory: Path, report_id: str) -> None:
    """Remove the provenance sidecar of a report, if any."""
    if not is_valid_report_id(report_id):
        return
    path = directory / f"{report_id}.json"
    if path.is_file():
        path.unlink()
