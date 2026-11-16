"""Baltimore Bird - Middleware de sécurité HTTP."""

from flask import Flask, Response

# Directive CSP posée par une route qui sert un document non fiable (rapport HTML) :
# le navigateur lui attribue une origine opaque, sans accès aux cookies ni au stockage de
# l'application, y compris ouvert hors iframe (SEC-16). Pas d'allow-same-origin, qui
# annulerait l'isolement.
SANDBOXED_DOCUMENT_CSP = "sandbox allow-scripts allow-popups allow-downloads"


def mark_sandboxed_document(response: Response) -> Response:
    """Marks a response as an untrusted document rendered in an opaque origin.

    The security middleware keeps this directive when it writes the global policy.

    Args:
        response: Response serving untrusted HTML.

    Returns:
        The same response, for chaining.
    """
    response.headers["Content-Security-Policy"] = SANDBOXED_DOCUMENT_CSP
    return response


def add_security_headers(response: Response, debug: bool = False) -> Response:
    """Ajoute les headers de sécurité à toutes les réponses."""
    sandboxed = response.headers.get("Content-Security-Policy") == SANDBOXED_DOCUMENT_CSP
    if not debug:
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"

    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()"

    csp_directives = [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://cdn.plot.ly",
        "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com"
        " https://cdn.plot.ly https://fonts.googleapis.com",
        "img-src 'self' data: blob:",
        "font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net data:",
        "connect-src 'self'",
        "frame-ancestors 'self'",
        "form-action 'self'",
        "base-uri 'self'",
        "object-src 'none'",
    ]
    if sandboxed:
        csp_directives.append(SANDBOXED_DOCUMENT_CSP)
    response.headers["Content-Security-Policy"] = "; ".join(csp_directives)

    return response


def register_security_middleware(app: Flask) -> None:
    """Enregistre le middleware de sécurité sur l'application Flask."""
    @app.after_request
    def security_headers_middleware(response: Response) -> Response:
        return add_security_headers(response, debug=app.debug)
