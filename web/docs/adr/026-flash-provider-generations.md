# ADR-026: Flash provider and immutable tree generations

> Status: Accepted for opt-in internal raw/merge provider; default-provider quality and full product acceptance remain open
> Date: 2026-09-08

Adopt the pinned PageIndex Flash raw extractor and deterministic merge functions as a finite vendored dependency.
Do not install its unrelated chat/cloud/model SDK closure or its default full+summary path. Preserve upstream code,
MIT attribution and hashes; generated function extraction must preserve exact source bodies and fail on dependency drift.
Only the Flash package initializer changes to remove the unused public chat/summary API import. The product calls the
version-pinned internal extract_toc(workers=1) and exposes its own independently versioned provider contract.

Run parsing in a separate Linux namespace process with read-only approved PDF/code/runtime, clean environment, no
network, CPU/address-space/output/wall limits, seccomp no-fork/exec/socket and no automatic process-pool fanout. A failed/empty tree does not revoke
the existing original PDF, FTS or block-map index. No model credentials reach Python; future summary/expand remains
a separate Pi-governed job, not hidden in this provider.

Publish raw and merge as immutable, content/config/provider-bound generations. Never renumber an existing tree used
by Evidence or research overlays. Provider-local node IDs are not global identity; product node IDs include generation.
Trees are navigation candidates and page ranges only, not block/character geometry or verified evidence.

Merge may reuse verified raw data without parsing again, preserving all fields consumed by the deterministic functions.
Tests and three real source PDFs compare entire generated data/metrics with the full reparse path. Publish/check metadata
seals as well as tree data hashes; never overwrite a prior generation. The CLI is a one-shot internal tool, not an authenticated Web endpoint.

New tree-index.v1 contracts distinguish build requests, immutable manifest/data and paged tree reads. They do not alter
legacy sidecar-document-rpc, its capability advertisement or old DSH field meanings. Integration begins at the internal
DocumentService, using verified original assets for the requested revision/hash, never arbitrary browser paths.

Acceptance requires shared TS/Python shape/semantic fixtures, vendor checks, real raw/bookmark/merge output, package-only
execution, immutable/cache/cancellation/failure tests and unchanged original/FTS availability. Broader real-corpus quality,
legacy comparisons, multilingual/OCR, controlled parallelism, Pi enhancement jobs and Web integration remain R5/R1–R7 work.

Verified internal baseline: 491 JS tests (one existing skip), 132 Python tests including 22 shared tree fixtures/eight
provider tests, independent installed-wheel execution, 82-file vendor/source closure check, and legacy browser rerun 6/6.
First browser run had a failed React DOM request with ERR_NETWORK_CHANGED; that transient failure is recorded rather
than hidden. This baseline is not default-provider quality or full product acceptance.
