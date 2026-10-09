# ADR-035: Managed conversations and verified native session reopen

> Status: Internal implementation; crash supervision/recovery release gate remains open
> Date: 2026-09-09

The application owns a durable runtime catalog separate from ControlStore and Pi JSONL. It records binding/session identity,
the private native filename, an exact closed-file seal, and an exclusive random claim. Claims commit before worker startup;
clean release commits only after coordinator shutdown, worker namespace disposal and native effects have joined. Concurrent
open calls share one runtime. Another process cannot acquire an active claim, even after its wall-clock lease expires.

Normal restart reopens the SAME verified native file through SessionManager.open, preserves native context/IDs/model and
loads the last verified product checkpoint projection. It does not rebuild chat from UI rows or re-prompt completed requests.
Missing/modified/foreign files, unavailable recorded models and ambiguous owners fail closed. Predispatch requests may be
re-prepared under fresh policy; dispatched/unknown work is never automatically replayed.

An unclean catalog claim is deliberately not cleared by PID/TTL guessing. This implementation does not claim abrupt-host-
death/cgroup supervision solved: operator recovery must first prove the prior process trees are gone. No HTTP recovery
override, automatic reset or stale-writer takeover is introduced. Native files are retained, including cancelled/failed
entries, but the current public history projection remains checkpoint-bound; complete historical rendering is separate.

Add idempotent authenticated conversation creation with application-issued runtime IDs and server-owned paths. Browser
requests cannot set resource approvals, directories, providers or native filenames. A configured manager lazily creates
bounded runtimes; browser observation alone never replays dispatched work. Live new-chat actions reuse an uncertain creation
key across retries. Existing legacy/user databases are not silently migrated or moved.
