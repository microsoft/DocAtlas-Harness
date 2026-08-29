from __future__ import annotations

import json
import os
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from docatlas import remote_pdf
from docatlas.remote_pdf import (
    RemotePDFDownloader,
    RemotePDFError,
    mask_url_query_values,
    safe_display_url,
)

_PDF = b"%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n"


class _PDFHandler(BaseHTTPRequestHandler):
    requests: list[tuple[str, str]] = []

    def log_message(self, format: str, *args) -> None:
        return

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        self.__class__.requests.append((self.path, self.headers.get("If-None-Match", "")))
        if self.path.startswith("/private-redirect"):
            self.send_response(302)
            self.send_header(
                "Location",
                f"http://127.0.0.1:{self.server.server_port}/report.pdf",
            )
            self.end_headers()
            return
        if self.path.startswith("/redirect"):
            self.send_response(302)
            self.send_header("Location", "/report.pdf?token=redirect-secret")
            self.end_headers()
            return
        if self.path.startswith("/loop"):
            self.send_response(302)
            self.send_header("Location", "/loop")
            self.end_headers()
            return
        if self.path.startswith("/html"):
            payload = b"<html>not a pdf</html>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if self.path.startswith("/fake"):
            payload = b"not a pdf"
            self.send_response(200)
            self.send_header("Content-Type", "application/pdf")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if self.path.startswith("/large"):
            self.send_response(200)
            self.send_header("Content-Type", "application/pdf")
            self.send_header("Content-Length", "1000")
            self.end_headers()
            return
        no_validator = self.path.startswith("/no-validator")
        if not no_validator and self.headers.get("If-None-Match") == '"fixture-v1"':
            self.send_response(304)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/pdf; charset=binary")
        self.send_header("Content-Length", str(len(_PDF)))
        self.send_header("Content-Disposition", "attachment; filename=annual-report.pdf")
        if not no_validator:
            self.send_header("ETag", '"fixture-v1"')
        self.end_headers()
        self.wfile.write(_PDF)


@contextmanager
def _pdf_server():
    _PDFHandler.requests = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), _PDFHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def _allow_test_server(monkeypatch) -> None:
    monkeypatch.setattr(
        remote_pdf,
        "_resolve_public_addresses",
        lambda hostname, port: ["127.0.0.1"],
    )


def test_downloader_rejects_private_and_credentialed_urls(tmp_path: Path) -> None:
    downloader = RemotePDFDownloader(tmp_path / "downloads")

    with pytest.raises(RemotePDFError, match="local, private"):
        downloader.download("http://127.0.0.1/report.pdf")
    with pytest.raises(RemotePDFError, match="credentials embedded"):
        downloader.download(
            "https://user:secret@example.com/report.pdf"  # pragma: allowlist secret
        )
    with pytest.raises(RemotePDFError, match="HTTP or HTTPS"):
        downloader.download("file:///tmp/report.pdf")
    with pytest.raises(RemotePDFError, match="control characters"):
        downloader.download("https://example.com/report\n.pdf")


def test_downloads_pdf_privately_and_revalidates_cache(tmp_path: Path, monkeypatch) -> None:
    _allow_test_server(monkeypatch)
    downloader = RemotePDFDownloader(tmp_path / "downloads")
    with _pdf_server() as origin:
        url = f"{origin}/report.pdf?token=top-secret"
        first = downloader.download(url)
        first_mtime = first.path.stat().st_mtime_ns
        second = downloader.download(url)

    assert first.path == second.path
    assert first.path.name == "annual-report.pdf"
    assert first.path.read_bytes() == _PDF
    assert first.from_cache is False
    assert second.from_cache is True
    assert second.path.stat().st_mtime_ns == first_mtime
    assert first.path.stat().st_mode & 0o777 == 0o600
    assert first.path.parent.stat().st_mode & 0o077 == 0
    metadata = (first.path.parent / "metadata.json").read_text(encoding="utf-8")
    assert "top-secret" not in metadata
    assert "top-secret" not in first.display_url
    assert any(etag == '"fixture-v1"' for _, etag in _PDFHandler.requests)


def test_follows_safe_redirect_and_hides_redirect_query(tmp_path: Path, monkeypatch) -> None:
    _allow_test_server(monkeypatch)
    with _pdf_server() as origin:
        result = RemotePDFDownloader(tmp_path / "downloads").download(
            f"{origin}/redirect?token=initial-secret"
        )

    assert result.path.read_bytes() == _PDF
    metadata = json.loads((result.path.parent / "metadata.json").read_text(encoding="utf-8"))
    assert "initial-secret" not in repr(metadata)
    assert "redirect-secret" not in repr(metadata)


def test_revalidates_redirect_destination_against_ssrf_policy(tmp_path: Path, monkeypatch) -> None:
    def resolve(hostname: str, port: int) -> list[str]:
        del port
        if hostname == "public.test":
            return ["127.0.0.1"]
        raise RemotePDFError("redirect resolved to a local, private address")

    monkeypatch.setattr(remote_pdf, "_resolve_public_addresses", resolve)
    with _pdf_server() as origin:
        port = origin.rsplit(":", 1)[1]
        with pytest.raises(RemotePDFError, match="local, private"):
            RemotePDFDownloader(tmp_path / "downloads").download(
                f"http://public.test:{port}/private-redirect"
            )


def test_identical_unvalidated_response_reuses_cached_file_mtime(
    tmp_path: Path, monkeypatch
) -> None:
    _allow_test_server(monkeypatch)
    downloader = RemotePDFDownloader(tmp_path / "downloads")
    with _pdf_server() as origin:
        first = downloader.download(f"{origin}/no-validator.pdf")
        first_mtime = first.path.stat().st_mtime_ns
        second = downloader.download(f"{origin}/no-validator.pdf")

    assert second.from_cache is True
    assert second.path == first.path
    assert second.path.stat().st_mtime_ns == first_mtime


def test_tampered_cached_pdf_is_downloaded_again(tmp_path: Path, monkeypatch) -> None:
    _allow_test_server(monkeypatch)
    downloader = RemotePDFDownloader(tmp_path / "downloads")
    with _pdf_server() as origin:
        url = f"{origin}/report.pdf"
        first = downloader.download(url)
        first.path.write_bytes(b"%PDF-tampered")
        second = downloader.download(url)

    assert second.from_cache is False
    assert second.path.read_bytes() == _PDF
    assert all(not etag for _, etag in _PDFHandler.requests[-1:])


@pytest.mark.parametrize(
    ("endpoint", "message", "max_bytes"),
    [
        ("html", "not a PDF", 1024),
        ("fake", "valid PDF header", 1024),
        ("large", "exceeds", 100),
        ("loop", "redirect limit", 1024),
    ],
)
def test_rejects_non_pdf_oversized_and_redirect_loop_responses(
    tmp_path: Path,
    monkeypatch,
    endpoint: str,
    message: str,
    max_bytes: int,
) -> None:
    _allow_test_server(monkeypatch)
    with _pdf_server() as origin:
        downloader = RemotePDFDownloader(
            tmp_path / "downloads", max_bytes=max_bytes, max_redirects=2
        )
        with pytest.raises(RemotePDFError, match=message):
            downloader.download(f"{origin}/{endpoint}")


def test_safe_display_url_removes_secrets_and_intermediate_path() -> None:
    display = safe_display_url(
        "https://example.com/private/account-token/reports/annual.pdf?sig=secret#fragment"
    )

    assert display == "https://example.com/annual.pdf"
    assert "secret" not in display
    assert "account-token" not in display
    assert mask_url_query_values("open https://example.com/a.pdf?sig=secret now") == (
        "open https://example.com/a.pdf?********** now"
    )


def test_cache_rejects_symbolic_link_components(tmp_path: Path) -> None:
    target = tmp_path / "target"
    target.mkdir()
    cache = tmp_path / "downloads"
    cache.symlink_to(target, target_is_directory=True)

    with pytest.raises(RemotePDFError, match="symbolic links"):
        RemotePDFDownloader(cache).download("https://example.com/report.pdf")


def test_cache_metadata_never_contains_original_query(tmp_path: Path, monkeypatch) -> None:
    _allow_test_server(monkeypatch)
    with _pdf_server() as origin:
        downloader = RemotePDFDownloader(tmp_path / "downloads")
        result = downloader.download(f"{origin}/report.pdf?X-Amz-Credential=do-not-store")

    all_cache_text = "\n".join(
        path.read_text(encoding="utf-8", errors="ignore")
        for path in result.path.parents[1].rglob("*.json")
    )
    assert "do-not-store" not in all_cache_text
    assert os.path.commonpath([result.path, tmp_path]) == str(tmp_path)
