"""Native PDF entry point. Only /input/source.pdf and bounded tmpfs are available."""

from __future__ import annotations

import base64
import contextlib
import io
import json
import re
import resource
import sys
from pathlib import Path
from typing import Any

from .process_security import lock_process_creation


def validate_request(request: object) -> None:
    if not isinstance(request, dict):
        raise ValueError("Invalid PDF request")
    operation = request.get("operation")
    fields = {
        "extract": {"maxPages", "expectedPages"},
        "locate": {"physicalPage", "exact"},
        "render": {"physicalPage", "maxPixels"},
    }
    if (
        not isinstance(operation, str)
        or operation not in fields
        or set(request) != {"version", "operation", "sourceHash"} | fields[operation]
    ):
        raise ValueError("Invalid PDF request fields")
    if (
        type(request["version"]) is not int
        or request["version"] != 1
        or not isinstance(request["sourceHash"], str)
        or re.fullmatch(r"[a-f0-9]{64}", request["sourceHash"]) is None
    ):
        raise ValueError("Invalid PDF request identity")
    for name in ("maxPages", "expectedPages", "physicalPage", "maxPixels"):
        value = request.get(name)
        if value is not None and (
            type(value) is not int
            or not 1 <= value <= (40_000_000 if name == "maxPixels" else 10_000_000)
        ):
            raise ValueError("Invalid PDF numeric limit")
    if operation != "extract" and request["physicalPage"] is None:
        raise ValueError("Missing physical page")
    if operation == "render" and request["maxPixels"] is None:
        raise ValueError("Missing pixel limit")
    if operation == "locate" and (
        not isinstance(request["exact"], str) or not 1 <= len(request["exact"]) <= 100000
    ):
        raise ValueError("Invalid PDF text selector")


def build(request: dict[str, Any]) -> Any:
    validate_request(request)
    resource.setrlimit(resource.RLIMIT_AS, (4 * 1024**3, 4 * 1024**3))
    resource.setrlimit(resource.RLIMIT_CPU, (60, 60))
    resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
    resource.setrlimit(resource.RLIMIT_FSIZE, (32 * 1024**2, 32 * 1024**2))
    lock_process_creation()
    from .pdf_isolation import PdfWorkerError, source_digest
    from .pdf_native import extract, locate, render

    source = Path("/input/source.pdf")
    with source.open("rb") as stream:
        signature = stream.read(5)
    if source_digest(source) != request["sourceHash"] or signature != b"%PDF-":
        raise PdfWorkerError("source-integrity", "PDF identity mismatch")
    result: Any
    if request["operation"] == "extract":
        result = extract(source, request["maxPages"], request["expectedPages"], lambda: None)
    elif request["operation"] == "locate":
        result = locate(source, request["physicalPage"], request["exact"])
    elif request["operation"] == "render":
        output = io.BytesIO()
        result = render(source, request["physicalPage"], request["maxPixels"], output, lambda: None)
        result["png"] = base64.b64encode(output.getvalue()).decode("ascii")
    else:
        raise PdfWorkerError("unavailable", "Unknown PDF operation")
    if source_digest(source) != request["sourceHash"]:
        raise PdfWorkerError("source-integrity", "PDF changed during processing")
    return result


def main() -> int:
    request = json.load(sys.stdin)
    result = {
        "version": 1,
        "operation": request.get("operation"),
        "sourceHash": request.get("sourceHash"),
    }
    try:
        with contextlib.redirect_stdout(sys.stderr):
            result["result"] = build(request)
    except Exception as error:
        result["error"] = getattr(error, "code", "unavailable")
    sys.stdout.write(json.dumps(result, ensure_ascii=False, allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
