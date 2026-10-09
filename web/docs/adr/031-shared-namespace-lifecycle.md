# ADR-031: Shared namespace lifecycle, not monitor-only cancellation

> Status: Internal Linux implementation
> Date: 2026-09-08

Use one Node SandboxProcess guard for Pi, native execution and document/tree coordinator launches. Every actual launcher
provides a private bwrap info FD; bounded UTF-8 metadata must identify an owned child/start-time. Early cancellation waits
for identity, kills the namespace, permits its monitor to reap it and joins namespace termination as well as closed stdio.
Malformed or foreign metadata must not become a signal target. A grace timer concerns the monitor, not false completion.

Python PDF and Flash share the same lifecycle rule using kernel pidfds. The pinned standalone Python build lacks the
os.pidfd_open wrapper, so a small ctypes syscall adapter supports Linux x86_64/aarch64; no PID-only fallback is allowed.
Native PDF/Flash algorithms, file mounts, resource bounds and publication rules are unchanged. Cancellation must finish
cleanup before returning; errors and incomplete outputs never publish a tree or image.

This covers application-controlled startup/stop and resource revocation. Host death, kernel stalls, cgroup aggregate
quotas, cross-platform support and system-service ownership remain distinct release gates, not inferred from these tests.
