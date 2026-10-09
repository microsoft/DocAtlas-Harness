"""Shared kernel restrictions for document-only native parser workers."""

import ctypes
import errno


def lock_process_creation() -> None:
    """Kernel filter: a native parser cannot bypass the Python audit hook to fork/exec/network."""
    try:
        library = ctypes.CDLL("libseccomp.so.2", use_errno=True)
        library.seccomp_init.argtypes = [ctypes.c_uint32]
        library.seccomp_init.restype = ctypes.c_void_p
        library.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
        library.seccomp_syscall_resolve_name.restype = ctypes.c_int
        library.seccomp_rule_add.argtypes = [
            ctypes.c_void_p,
            ctypes.c_uint32,
            ctypes.c_int,
            ctypes.c_uint,
        ]
        library.seccomp_load.argtypes = [ctypes.c_void_p]
        library.seccomp_release.argtypes = [ctypes.c_void_p]
        context = library.seccomp_init(0x7FFF0000)
        if not context:
            raise ValueError("unavailable")
        try:
            for name in (
                "clone",
                "clone3",
                "fork",
                "vfork",
                "execve",
                "execveat",
                "socket",
                "memfd_create",
                "shmget",
                "msgget",
                "semget",
                "mount",
                "umount2",
                "unshare",
                "setns",
                "ptrace",
                "process_vm_readv",
                "process_vm_writev",
                "bpf",
                "perf_event_open",
                "userfaultfd",
                "io_uring_setup",
                "keyctl",
                "add_key",
                "request_key",
            ):
                number = library.seccomp_syscall_resolve_name(name.encode())
                if (
                    number < 0
                    or library.seccomp_rule_add(context, 0x00050000 | errno.EPERM, number, 0) != 0
                ):
                    raise ValueError("unavailable")
            if library.seccomp_load(context) != 0:
                raise ValueError("unavailable")
        finally:
            library.seccomp_release(context)
        # Verify the loaded socket rule at the native syscall layer, not through Python's hook.
        libc = ctypes.CDLL(None, use_errno=True)
        number = library.seccomp_syscall_resolve_name(b"socket")
        if libc.syscall(number, 2, 1, 0) != -1 or ctypes.get_errno() != errno.EPERM:
            raise ValueError("unavailable")
    except OSError:
        raise ValueError("unavailable") from None
