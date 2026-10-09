# ADR-028: Two-level Linux document process isolation

> Status: Accepted for the internal DocAtlas Node document path; full Pi/product gate remains open
> Date: 2026-09-08 · Supersedes ADR-027's unisolated Node launcher, not its remaining product gates

The Node document launcher now uses an empty filesystem namespace, private PID/network/IPC namespaces, clean environment,
read-only installed runtime/code and explicitly approved source roots. Only the document cache is writable. ControlStore's
root and the Core domain root are automatically protected; callers must include any other private model/profile directories
in protectedRoots and keep them out of runtime/source/cache grants. Source/cache/protected overlaps and symlink traversal
fail before launch. Runtime bootstrap is a bounded asynchronous uv probe of trusted installation metadata, not document data.
No package sync, installation, credential lookup or model call occurs in the document process.

Conversation readers get no source-directory grants: `--cache-only` advertises search/read/resolve without ingest. Library
imports retain their separately owned source grants/process. Flash one-shot jobs use the same outer document boundary.
This does not turn the legacy DSH subprocess launcher into the new Node launcher; its compatibility path remains separate.

All pypdf/PDFium parsing in ingest, rendering and geometry is moved behind a single-file native worker. The trusted Python
coordinator no longer imports those PDF libraries. Workers see only the exact source PDF, runtime/code and read-only tmp/dev,
not the cache, other documents, source directory, domain journals, model credentials or host processes. There is no writable
output directory: PNG encoding uses bounded memory and the parent validates bytes/hash/dimensions before publication.

The shared seccomp guard denies fork/clone/exec/socket and additional mount/namespace/ptrace/IPC/memfd/kernel interfaces.
PDF workers have 60 CPU seconds, 90 wall seconds, 4 GiB address-space, 128 FDs, 512 MiB input and 48 MiB response bounds;
PNG output remains 32 MiB/40M pixels. Transport is nonblocking/bounded, cancellation kills and waits for the process group.
Source hash is checked before/after parsing and response identity checked by the coordinator. Bad/ambiguous geometry never
creates a guessed highlight. Existing original asset, representation, block and locator meanings remain unchanged.

Flash uses the same reviewed kernel guard; its provider fingerprint now includes that guard. Vendor source is unchanged.
New generations reflect adapter identity; previous immutable generations are not rewritten. No hidden LLM enrichment added.

Evidence: actual Node namespace/private-state/network/RO-source probes; libc fork/socket/memfd probes inside the PDF worker;
native-vs-isolated text/PNG/geometry equality; existing PDF matrix and Pi six-mode/native-tool/checkpoint flow; installed wheel.
These checks are not a proof against kernel vulnerabilities or arbitrary bugs in the trusted coordinator/runtime. Aggregate
workspace quotas, the full Pi/extension/model process boundary, non-Linux equivalent isolation, product auth/HTTP, upload/
selection/Answer and full Web/research/quality gates remain open. No public endpoint or deployment is enabled by this ADR.
