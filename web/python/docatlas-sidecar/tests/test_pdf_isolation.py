from __future__ import annotations

import base64
import io
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest
from pypdf import PdfReader

from docatlas_dsh_sidecar.block_index import normalize_page_text
from docatlas_dsh_sidecar.pdf_isolation import PdfWorkerError, call_pdf, pdf_command, source_digest
from docatlas_dsh_sidecar.pdf_native import locate, render
from docatlas_dsh_sidecar.pdf_worker import validate_request


@pytest.mark.parametrize(
    "change",
    [
        {"sourceHash": "wrong"},
        {"version": True},
        {"maxPixels": True},
        {"physicalPage": None},
        {"extra": "hidden"},
    ],
)
def test_worker_request_validation(change: dict[str, object]) -> None:
    request = {
        "version": 1,
        "sourceHash": "a" * 64,
        "operation": "render",
        "physicalPage": 1,
        "maxPixels": 1000,
    }
    validate_request(request)
    with pytest.raises(ValueError):
        validate_request({**request, **change})


@pytest.fixture
def source(tmp_path: Path) -> Path:
    path = tmp_path / "approved.pdf"
    encoded = Path(__file__).resolve().parents[3] / "apps/web/fixtures/sample-report.pdf.base64"
    path.write_bytes(base64.b64decode(encoded.read_bytes()))
    return path


def test_isolated_text_pixels_and_geometry_equal_native_algorithms(source: Path) -> None:
    digest = source_digest(source)
    expected = [normalize_page_text(page.extract_text() or "") for page in PdfReader(source).pages]
    result = call_pdf(
        source, digest, "extract", {"maxPages": None, "expectedPages": 6}, lambda: None
    )
    assert result["pages"] == expected
    assert result["totalPages"] == 6
    output = io.BytesIO()
    image = render(source, 1, 250_000, output, lambda: None)
    isolated = call_pdf(
        source, digest, "render", {"physicalPage": 1, "maxPixels": 250_000}, lambda: None
    )
    assert base64.b64decode(isolated.pop("png")) == output.getvalue()
    assert isolated == image
    exact = next(line.strip() for line in expected[0].splitlines() if line.strip())
    geometry = locate(source, 1, exact)
    assert geometry is not None
    assert (
        call_pdf(source, digest, "locate", {"physicalPage": 1, "exact": exact}, lambda: None)
        == geometry
    )


def test_native_parser_cannot_escape_one_file_namespace(source: Path) -> None:
    other = source.parent / "other-document.txt"
    other.write_text("PRIVATE_OTHER_SOURCE")
    command = pdf_command(source)
    code_root = str(Path(__file__).resolve().parents[1] / "src")
    probe = f"""
import sys,json,os,ctypes,resource
sys.path.insert(0,{code_root!r})
import docatlas_dsh_sidecar.pdf_native as native
from docatlas_dsh_sidecar.pdf_worker import build
def probe(*args):
 lib=ctypes.CDLL(None,use_errno=True)
 fork=lib.fork()
 if fork==0: os._exit(0)
 if fork>0: os.waitpid(fork,0)
 sock=lib.socket(2,1,0)
 if sock>=0: os.close(sock)
 memfd=lib.memfd_create(b'probe',0)
 if memfd>=0: os.close(memfd)
 try:
  open('/tmp/write-attempt','wb').close();writable=True
 except OSError: writable=False
 return {{'fork':fork,'socket':sock,'memfd':memfd,'writable':writable,
 'other':os.path.exists({str(other)!r}),
 'parent':os.path.exists('/proc/{os.getpid()}/cmdline'),'env':'DOCATLAS_PDF_CANARY' in os.environ,
 'cpu':resource.getrlimit(resource.RLIMIT_CPU)[0],'memory':resource.getrlimit(resource.RLIMIT_AS)[0]}}
native.extract=probe
print(json.dumps(build(json.loads(sys.stdin.read()))))
"""
    command[-1] = probe
    request = {
        "version": 1,
        "sourceHash": source_digest(source),
        "operation": "extract",
        "maxPages": 1,
        "expectedPages": 6,
    }
    process = subprocess.run(
        command,
        input=json.dumps(request),
        capture_output=True,
        text=True,
        timeout=10,
        env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
    )
    assert process.returncode == 0, process.stderr
    result = json.loads(process.stdout)
    assert result == {
        "fork": -1,
        "socket": -1,
        "memfd": -1,
        "writable": False,
        "other": False,
        "parent": False,
        "env": False,
        "cpu": 60,
        "memory": 4 * 1024**3,
    }


def test_hash_mismatch_deadline_and_cancellation_do_not_publish(source: Path) -> None:
    with pytest.raises(PdfWorkerError, match="source-integrity"):
        call_pdf(source, "0" * 64, "extract", {"maxPages": 1, "expectedPages": 6}, lambda: None)
    with pytest.raises(PdfWorkerError, match="deadline"):
        call_pdf(
            source,
            source_digest(source),
            "extract",
            {"maxPages": 1, "expectedPages": 6},
            lambda: None,
            wall_seconds=0.001,
        )
    deadline = time.monotonic() + 0.01

    def cancelled() -> None:
        if time.monotonic() >= deadline:
            raise InterruptedError("cancelled")

    with pytest.raises(InterruptedError):
        call_pdf(
            source, source_digest(source), "extract", {"maxPages": 1, "expectedPages": 6}, cancelled
        )
    assert not list(source.parent.glob("*.png"))


def test_coordinator_does_not_import_native_pdf_libraries() -> None:
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys; import docatlas_dsh_sidecar.__main__;"
            "assert 'pypdfium2' not in sys.modules; assert 'pypdf' not in sys.modules",
        ],
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr


def test_cache_only_process_has_no_ingest_capability(tmp_path: Path) -> None:
    import argparse

    from docatlas_dsh_sidecar.__main__ import _document_service
    from docatlas_dsh_sidecar.protocol import capabilities_result, handle_request

    service = _document_service(argparse.ArgumentParser(), str(tmp_path / "cache"), [], True)
    capabilities = capabilities_result(service)
    assert "read" in capabilities["methods"]
    assert "ingest" not in capabilities["methods"]
    result = handle_request(
        {"jsonrpc": "2.0", "id": "forbidden", "method": "ingest", "params": {}}, service
    )
    assert result["error"]["code"] == -32601
