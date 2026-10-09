"""Trusted bwrap lifecycle. Retain namespace identity before allowing early teardown."""

from __future__ import annotations

import ctypes
import json
import os
import platform
import select
import signal
import subprocess
import time
from collections.abc import Mapping
from types import TracebackType


class SandboxProcess:
    def __init__(self, command: list[str], env: Mapping[str, str]) -> None:
        read_fd, write_fd = os.pipe()
        self.namespace_pid: int | None = None
        self._pidfd: int | None = None
        self._closed = False
        try:
            self.process = subprocess.Popen(
                [command[0], "--info-fd", str(write_fd), *command[1:]],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
                pass_fds=(write_fd,),
                start_new_session=True,
            )
        except BaseException:
            os.close(read_fd)
            raise
        finally:
            os.close(write_fd)
        try:
            self._identify(read_fd)
        except BaseException:
            self.close()
            raise
        finally:
            os.close(read_fd)

    def _identify(self, read_fd: int) -> None:
        deadline = time.monotonic() + 10
        data = bytearray()
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([read_fd], [], [], remaining)[0]:
                raise RuntimeError("Sandbox identity bootstrap timed out")
            chunk = os.read(read_fd, 8193 - len(data))
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > 8192:
                raise RuntimeError("Sandbox metadata exceeds limit")
        if not data:
            # A launcher that fails before clone has no namespace to terminate.
            self.process.wait(timeout=10)
            return
        value = json.loads(data)
        pid = value.get("child-pid") if isinstance(value, dict) else None
        if type(pid) is not int or pid <= 1:
            raise RuntimeError("Missing sandbox namespace identity")
        try:
            before = _fields(pid)
            if int(before[1]) != self.process.pid:
                raise RuntimeError("Sandbox namespace parent mismatch")
            pidfd = _pidfd_open(pid)
            try:
                if _fields(pid)[19] != before[19]:
                    raise RuntimeError("Sandbox namespace identity changed")
            except BaseException:
                os.close(pidfd)
                raise
            self.namespace_pid, self._pidfd = pid, pidfd
        except (FileNotFoundError, ProcessLookupError):
            # Valid metadata from a namespace that finished before it was observed.
            return

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            if self._pidfd is not None:
                try:
                    _pidfd_kill(self._pidfd)
                except ProcessLookupError:
                    pass
                # This is kernel process termination, not a cancellation acknowledgement.
                select.select([self._pidfd], [], [])
            # Allow the monitor to reap init before considering a forced monitor exit.
            try:
                self.process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(self.process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            self.process.wait()
        finally:
            if self._pidfd is not None:
                os.close(self._pidfd)
            for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
                if stream is not None:
                    stream.close()

    def __enter__(self) -> SandboxProcess:
        return self

    def __exit__(
        self,
        exception_type: type[BaseException] | None,
        exception: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.close()


def _fields(pid: int) -> list[str]:
    with open(f"/proc/{pid}/stat", encoding="utf-8") as stream:
        return stream.read().rsplit(") ", 1)[1].split()


def _syscall(number: int, *args: object) -> int:
    # Pinned python-build-standalone lacks os.pidfd_open on older build headers.
    # These Linux architectures share the generic pidfd syscall numbers; no PID-only fallback.
    if platform.system() != "Linux" or platform.machine() not in {"x86_64", "aarch64"}:
        raise RuntimeError("Kernel pidfd lifecycle is unavailable on this architecture")
    library = ctypes.CDLL(None, use_errno=True)
    call = library.syscall
    call.restype = ctypes.c_long
    call.argtypes = [ctypes.c_long]
    result = int(call(number, *args))
    if result < 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))
    return result


def _pidfd_open(pid: int) -> int:
    return _syscall(434, ctypes.c_int(pid), ctypes.c_uint(0))


def _pidfd_kill(fd: int) -> None:
    _syscall(
        424, ctypes.c_int(fd), ctypes.c_int(signal.SIGKILL), ctypes.c_void_p(), ctypes.c_uint(0)
    )
