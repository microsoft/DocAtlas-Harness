"""Single-PDF worker transport. No cache, credentials, or other source is mounted."""

from __future__ import annotations

import hashlib
import json
import os
import selectors
import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .sandbox_process import SandboxProcess

MAX_OUTPUT_BYTES = 48 * 1024**2
MAX_SOURCE_BYTES = 512 * 1024**2


class PdfWorkerError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def pdf_command(source: Path) -> list[str]:
    if sys.platform != "linux" or not Path("/usr/bin/bwrap").is_file():
        raise PdfWorkerError("unavailable", "PDF processing requires Linux isolation")
    if source.is_symlink() or source.resolve(strict=True) != source or not source.is_file():
        raise PdfWorkerError("source-integrity", "PDF input is not a regular approved file")
    if source.stat().st_size > MAX_SOURCE_BYTES:
        raise PdfWorkerError("limit-exceeded", "PDF source exceeds the worker byte limit")
    code_root = Path(__file__).resolve().parents[1]
    args = [
        "/usr/bin/bwrap",
        "--unshare-user",
        "--unshare-pid",
        "--unshare-net",
        "--die-with-parent",
        "--new-session",
        "--tmpfs",
        "/tmp",
        "--remount-ro",
        "/tmp",
    ]
    for path in dict.fromkeys(
        [
            Path("/usr"),
            Path("/bin"),
            Path("/lib"),
            Path("/lib64"),
            Path(sys.base_prefix),
            Path(sys.prefix),
            code_root,
        ]
    ):
        args.extend(["--ro-bind", str(path), str(path)])
    args.extend(
        [
            "--proc",
            "/proc",
            "--dev",
            "/dev",
            "--remount-ro",
            "/dev",
            "--dir",
            "/input",
            "--ro-bind",
            str(source),
            "/input/source.pdf",
            "--chdir",
            "/tmp",
            "--",
            sys.executable,
            "-I",
            "-c",
            f"import sys,runpy;sys.path.insert(0,{str(code_root)!r});"
            "runpy.run_module('docatlas_dsh_sidecar.pdf_worker',run_name='__main__')",
        ]
    )
    return args


def call_pdf(
    source: Path,
    source_hash: str,
    operation: str,
    fields: dict[str, Any],
    check: Callable[[], None],
    *,
    wall_seconds: float = 90,
) -> Any:
    check()
    payload = json.dumps(
        {"version": 1, "operation": operation, "sourceHash": source_hash, **fields}, allow_nan=False
    ).encode()
    if len(payload) > 128 * 1024:
        raise PdfWorkerError("limit-exceeded", "PDF request exceeds the worker byte limit")
    args = pdf_command(source)
    deadline = time.monotonic() + wall_seconds
    sandbox = SandboxProcess(
        args,
        env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "PYTHONUNBUFFERED": "1"},
    )
    process = sandbox.process
    assert process.stdin is not None and process.stdout is not None and process.stderr is not None
    chunks: list[bytes] = []
    count = diagnostics = position = 0
    try:
        with selectors.DefaultSelector() as selector:
            for stream, event in [
                (process.stdin, selectors.EVENT_WRITE),
                (process.stdout, selectors.EVENT_READ),
                (process.stderr, selectors.EVENT_READ),
            ]:
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, event)
            while selector.get_map():
                check()
                if time.monotonic() >= deadline:
                    raise PdfWorkerError("limit-exceeded", "PDF worker deadline exceeded")
                for key, _event in selector.select(0.05):
                    ready_stream = key.fileobj
                    if ready_stream is process.stdin:
                        try:
                            position += os.write(key.fd, payload[position : position + 65536])
                        except BrokenPipeError:
                            position = len(payload)
                        if position == len(payload):
                            selector.unregister(ready_stream)
                            process.stdin.close()
                    else:
                        chunk = os.read(key.fd, 65536)
                        if not chunk:
                            selector.unregister(ready_stream)
                        elif ready_stream is process.stdout:
                            count += len(chunk)
                            if count > MAX_OUTPUT_BYTES:
                                raise PdfWorkerError(
                                    "limit-exceeded", "PDF worker output exceeded budget"
                                )
                            chunks.append(chunk)
                        else:
                            diagnostics += len(chunk)
                            if diagnostics > 65536:
                                raise PdfWorkerError(
                                    "limit-exceeded", "PDF worker diagnostic output exceeded budget"
                                )
            process.wait(timeout=max(0.01, deadline - time.monotonic()))
        check()
        if process.returncode != 0:
            raise PdfWorkerError("unavailable", "PDF worker exited without a result")
        try:
            result = json.loads(b"".join(chunks))
        except (ValueError, UnicodeError):
            raise PdfWorkerError("unavailable", "Invalid PDF worker response") from None
        if (
            not isinstance(result, dict)
            or result.get("version") != 1
            or result.get("sourceHash") != source_hash
            or result.get("operation") != operation
        ):
            raise PdfWorkerError("source-integrity", "PDF response identity mismatch")
        if "error" in result:
            code = result["error"]
            if code not in {
                "source-integrity",
                "encrypted-pdf",
                "not-found",
                "unavailable",
                "limit-exceeded",
            }:
                code = "unavailable"
            raise PdfWorkerError(code, f"PDF processing failed ({code})")
        if set(result) != {"version", "operation", "sourceHash", "result"}:
            raise PdfWorkerError("unavailable", "Unexpected PDF response fields")
        return result["result"]
    finally:
        sandbox.close()


def source_digest(source: Path) -> str:
    with source.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()
