"""Isolement des rapports HTML servis par /api/reports/<id> (SEC-16).

Exécution : python -m pytest api/test_report_sandbox.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from flask import Flask

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import api.reports as reports_module  # noqa: E402
from middleware.security import SANDBOXED_DOCUMENT_CSP, register_security_middleware  # noqa: E402


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """App with the reports blueprint and the real security middleware, on a temp reports dir."""
    monkeypatch.setattr(reports_module, "REPORTS_DIR", tmp_path)
    (tmp_path / "hostile.html").write_text(
        "<script>parent.sessionStorage.getItem('auth_token')</script>", encoding="utf-8"
    )
    flask_app = Flask(__name__)
    flask_app.register_blueprint(reports_module.reports_bp)
    register_security_middleware(flask_app)
    return flask_app.test_client()


def _directives(header: str) -> list[str]:
    return [part.strip() for part in header.split(";")]


def test_report_is_served_in_an_opaque_origin(client) -> None:
    response = client.get("/api/reports/hostile")
    assert response.status_code == 200
    directives = _directives(response.headers["Content-Security-Policy"])
    assert SANDBOXED_DOCUMENT_CSP in directives
    assert not any("allow-same-origin" in d for d in directives)


def test_report_keeps_the_global_policy(client) -> None:
    directives = _directives(client.get("/api/reports/hostile").headers["Content-Security-Policy"])
    assert "object-src 'none'" in directives
    assert "frame-ancestors 'self'" in directives


def test_other_responses_are_not_sandboxed(client) -> None:
    header = client.get("/api/reports").headers["Content-Security-Policy"]
    assert not any(d.startswith("sandbox") for d in _directives(header))
