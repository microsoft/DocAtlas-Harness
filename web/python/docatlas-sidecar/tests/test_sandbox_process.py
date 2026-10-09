from __future__ import annotations

import os
import select
from pathlib import Path

import pytest

from docatlas_dsh_sidecar.sandbox_process import SandboxProcess

pytestmark = pytest.mark.skipif(not Path("/usr/bin/bwrap").exists(), reason="Requires bwrap")


def command() -> list[str]:
    return [
        "/usr/bin/bwrap",
        "--unshare-user",
        "--unshare-pid",
        "--unshare-net",
        "--new-session",
        "--die-with-parent",
        "--ro-bind",
        "/usr",
        "/usr",
        "--ro-bind",
        "/bin",
        "/bin",
        "--ro-bind",
        "/lib",
        "/lib",
        "--ro-bind",
        "/lib64",
        "/lib64",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--",
        "/bin/sleep",
        "60",
    ]


@pytest.mark.parametrize("_attempt", range(4))
def test_immediate_teardown_waits_for_kernel_namespace_exit(_attempt: int) -> None:
    with SandboxProcess(command(), {"PATH": "/bin:/usr/bin"}) as sandbox:
        assert sandbox.namespace_pid is not None
        assert sandbox._pidfd is not None
        observer = os.dup(sandbox._pidfd)
    try:
        assert select.select([observer], [], [], 0)[0] == [observer]
        assert sandbox.process.poll() is not None
        assert sandbox.process.stdout is not None and sandbox.process.stdout.closed
    finally:
        os.close(observer)
