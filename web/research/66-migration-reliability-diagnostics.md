# Migration reliability diagnostics (2026-10-09)

The earlier aggregate timeout did not establish a namespace cancellation defect.
On this host, bubblewrap 0.4.0 sees 6,185 mountinfo entries. Independent probes
measured ordinary Node at 30–55ms versus sandbox shell/Node/read at roughly
1.5–2.3s (one loaded sample 4.3s). Lowering RLIMIT_NOFILE to 4096 did not remove
the delay. A raw-data-free syscall trace showed 15 reads of `self/mountinfo`
during one preflight, ~15k read calls; directory binding/remount setup dominated.
The original 25s SDK conformance test accumulated >20 independent namespace
launches. No system packages, bwrap binary, mount grants or join guard changed.

The revised tests split filesystem and native-tool capability families into
independent fixtures, retaining the original 15s/25s bounds and every native
operation/denial/actual-join assertion. Cancellation deadlines are unchanged.
This is not evidence that native startup was accelerated or that all kernels
have been performance-qualified; the user does not require benchmark equality.

Research Map reproduction also distinguished backend completion from DOM work.
A diagnostic-only extended observation run completed the whole saved-note/
revision/original/refresh/deletion journey. The original test started its 5s
highlight assertion at click dispatch, while the authenticated PDF resolver was
still running. Tests now await the exact successful focus response and verify
its original record before checking the unchanged DOM deadline. Save/revision
likewise await their actual command response. Diagnostic instrumentation and
extended observation timeouts are removed from the accepted test path.
The UI now explicitly says it is checking the original while that request owns
execution; it does not fabricate a highlight or skip source verification.

Evidence logs (local diagnostic artifacts): `/tmp/docatlas-native-latency.log`,
`/tmp/docatlas-native-latency-bounded-fds.log`,
`/tmp/docatlas-native-syscall-summary.log`,
`/tmp/docatlas-native-read-paths.log`, `/tmp/docatlas-map-diagnostic-4.log`.
Final focused/full/browser acceptance remains to be recorded by the migration
tracker; a diagnostic-only successful run is not that acceptance.

## Reproducible verification host

Later aggregate runs under fluctuating host load still timed out in different
multi-process integration cases, while identical focused/full earlier runs
passed. `scripts/clean-check.mjs` adds a verification-only outer namespace with
the project, exact toolchain/cache/browser assets and fresh temporary storage.
It does not inherit unrelated Docker mounts. Every test still uses the actual
product and nested bubblewrap/Python guards with unchanged deadlines; private
canaries are created inside this test host before verifying inner isolation.
The outer Node launch itself uses the shared SandboxProcess guard and joins
before deleting its own temporary directory. Research pins are read-only.
No production launcher, system installation or real user state changes.

Run through pinned Node with `bash scripts/pnpmw run check:clean-host` or
`bash scripts/pnpmw run test:live:clean-host`. The former runs the actual
`bash scripts/check.sh`. Browser artifacts remain in the project `.cache`, not
the temporary namespace. This standardizes correctness verification, not product
latency/benchmark performance, and does not replace testing supported deployment
environments. Plain-host failures and clean-host results must be reported apart.

## Dismissal is an immediate intent boundary

The first complete independent browser run found a separate real UI race in
Compare. Drawer Escape/close/backdrop waited for its 120ms exit animation before
calling Library's close callback. A held document metadata response delivered
inside that interval could still replace pane A after the user had cancelled.
The fix adds a synchronous dismissal callback: Library rejects its outstanding
ReaderNavigation intents immediately, while visual unmount keeps its animation.
The leaving drawer is inert, so it cannot accept a new action in that interval.
Switching to Flash also rejects pending reader intents. This changes neither
PDF identity/geometry nor native task cancellation or source admission.

The unchanged comparison journey is extended to cover Escape, the close button,
the backdrop and reduced motion, delivering the held real response immediately
after each dismissal. Both original documents/pages and zero model calls remain
asserted, without longer deadlines. Final evidence is in the migration tracker.

The complete suite also reproduced Chromium's finite-response observation issue
in human-research: the real PDF had already reached its verified highlight, but
Playwright's `response.finished()` remained pending after the client released
its bounded reader, until the existing 300s test deadline. `observeJsonAction`
records that same POST through `route.fetch`, forwards its exact status/bytes and
checks the real response object. It does not replay commands or synthesize an
API/PDF result. Related citation/creation checks use this helper while retaining
their original record/hash/highlight/model-count assertions. The compaction
test's old missing-citation phrase is aligned with the already accepted ADR-057
copy; no-citation and no-Evidence assertions remain unchanged.
