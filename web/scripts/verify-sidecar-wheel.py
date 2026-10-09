"""Verify the actual independent sidecar wheel, including finite Flash bytes."""

from __future__ import annotations

import hashlib
import subprocess
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "python/docatlas-sidecar/src/docatlas_dsh_sidecar"


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="docatlas-web-wheel-") as temporary:
        subprocess.run(
            [
                "uv",
                "build",
                "--python",
                "3.12.12",
                "--package",
                "docatlas-dsh-sidecar",
                "--build-constraints",
                str(ROOT / "build-constraints.txt"),
                "--wheel",
                "--out-dir",
                temporary,
            ],
            cwd=ROOT,
            check=True,
        )
        wheels = list(Path(temporary).glob("*.whl"))
        if len(wheels) != 1:
            raise RuntimeError("Expected exactly one sidecar wheel")
        files = sorted(
            path
            for path in PACKAGE.rglob("*")
            if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc"
        )
        with zipfile.ZipFile(wheels[0]) as archive:
            expected = {f"docatlas_dsh_sidecar/{path.relative_to(PACKAGE)}": path for path in files}
            actual = {
                name
                for name in archive.namelist()
                if name.startswith("docatlas_dsh_sidecar/") and not name.endswith("/")
            }
            if actual != set(expected):
                raise RuntimeError("Wheel package inventory does not match canonical sidecar")
            for name, path in expected.items():
                if (
                    hashlib.sha256(archive.read(name)).digest()
                    != hashlib.sha256(path.read_bytes()).digest()
                ):
                    raise RuntimeError(f"Packaged sidecar bytes differ: {name}")
        print(f"Independent sidecar wheel verified: {len(files)} source/data/license files")


if __name__ == "__main__":
    main()
