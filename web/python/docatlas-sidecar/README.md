# DocAtlas sidecar

Python document-processing process for `docatlas-dsh`. It deliberately has no Agent Loop, conversation persistence,
model routing, or credentials. Transport 1.2.0 / document RPC 1.1.0 exposes JSONL JSON-RPC `health` and `capabilities`. When launched
with an absolute cache root and approved source-root mappings, it additionally advertises ingest/search/read/resolve;
without that authority the methods remain unavailable.
Explicit `--cache-only --cache-root ...` enables indexed search/read/resolve without ingest or source-root grants.

All native PDF extraction/render/geometry now runs in a separate Linux bwrap/libseccomp worker with only the exact
source file mounted. The coordinator validates output before publishing assets/indexes; no native PDF library is loaded
in it. Worker text, PNG bytes and geometry are checked against the original algorithms. Missing isolation fails closed;
no unsandboxed PDF fallback is used. The DocAtlas Node launcher additionally isolates the coordinator itself; the legacy
DSH launcher is a separate compatibility path. See [ADR-028](../../docs/adr/028-document-process-isolation.md).

The M1 index layer supports revision-bound PDF embedded text and UTF-8 Markdown/plain text. It writes deterministic
blocks and SQLite FTS5 into immutable generations, then atomically switches a durable current pointer. Verified source
bytes and rendered pages are published as path-free immutable assets before their metadata becomes visible. OCR and
layout models are not installed or claimed by this baseline.

Text Read supports locate, exact blocks, neighbourhood expansion, and source-order sequential cursors. Visual Read uses
pinned PDFium to render bounded full-page PNG assets; figure crop requests remain unavailable until a figure provider
persists stable figure identities.

Run through uv:

```bash
uv run --project python/docatlas-sidecar docatlas-sidecar --health
```

The sidecar will not gain conversation, personal memory, model credentials, or a second Agent Loop. See the
[canonical implementation plan](../../docs/implementation-plan.md#8-progressive-document-core).

## Optional Flash tree provider

Flash 0.2.10 at ae169566 is now available through `DocumentService(..., flash_provider=FlashProvider())` and the
one-shot internal command `uv run --locked --project python/docatlas-sidecar docatlas-tree --cache-root /approved/cache`.
The CLI reads one `tree-index.v1` build/read request from stdin. Success is a tree-generation/tree-page; failures are
canonical protocol-error objects and nonzero exit. It requires an already ingested PDF revision/hash, not an arbitrary
source pathname. This does not add methods or falsely advertise tree reasoning search in the legacy JSON-RPC service.

The finite vendor contains raw Flash plus the exact deterministic merge closure, with MIT attribution/provenance.
raw and merge publish immutable, checksummed generations independently of original bytes, FTS and block maps. Merge
reuses the validated raw generation without parsing the PDF again; full-reparse comparisons cover its exact output.
Provider node IDs are scoped to the generation; the page-range tree is navigation, not verified evidence/geometry.

Linux bwrap + libseccomp are required. PDF/code/runtime mounts are read-only; process environment is clean; network is
unshared. A kernel filter denies fork/clone/exec/socket, in addition to Python audit checks. Default bounds: one parser
worker, 60 CPU seconds, 90 wall seconds, 2 GiB address space, 64 MiB source, 1,000 pages, 16 MiB output. Unavailable
isolation, cancellation, invalid data or resource limits publish no false tree. Empty extraction is explicitly `empty`.

No summary/full/expand model calls are hidden in Python. Future Pi-governed enhancement, real multilingual/OCR/legacy
retrieval quality, geometry and complete Web integration remain open. Do not use an environment/runtime directory for
private application state; only installed code/dependencies belong in its read-only runtime mounts.
