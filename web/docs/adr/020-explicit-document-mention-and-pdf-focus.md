# ADR-020: Explicit document mentions prepare Source Scope and PDF focus uses verified page geometry

- Status: Accepted
- Date: 2026-09-01
- Owners: DocAtlas maintainers
- Supersedes: ADR-017 decisions 5–6 where a trustworthy born-digital PDF geometry provider is available

## Context

The chat-first product surface accepted text such as `@data/report.pdf`, but direct Conversation submission reduced the
mention to ordinary prose. A new Session therefore reached the Agent with an unbound Source Scope even though the user
had explicitly named a document. Asking the user for confirmation did not help: Source Scope mutation is deliberately
not a model tool, so the Agent could not execute the confirmed inclusion.

Citation focus also opened the correct immutable PDF page but highlighted only its extracted HTML text rail. That was
truthful under ADR-017 while the extractor had no trustworthy geometry, but it did not satisfy the product interaction:
the user should verify a citation on the original PDF rendering, not on a Markdown or text surrogate.

## Decision

1. Submitting a supported explicit `@document` reference is a user inclusion action for that exact message. Before the
   message enters the DSH Agent Loop, the Client resolves the reference through authenticated DocAtlas Library RPC.
2. The browser never supplies a filesystem path to ingest. It uses reference text only as a bounded discovery query;
   the Host returns an expiring opaque candidate ID and remains responsible for configured-root containment, file
   identity, hashing, and materialization. Zero or multiple exact candidates fail before submission and retain the draft.
3. A unique candidate is imported—or exact-byte reused—and its current revision is added with an immutable Source Scope
   CAS patch while the Session is idle. Only after import and patch succeed does the Client call the scoped DSH
   Conversation service. Prompts without `@document` references do not change scope.
4. Exact-byte reuse still asks the sidecar to ensure the current index build specification. This upgrades derived indexes
   without changing the document/revision/representation identity or rewriting source bytes.
5. Born-digital PDF indexing keeps visible PDF lines independently addressable. On citation focus, PDFium reopens the
   immutable original asset, resolves the exact quote once in the PDF character layer, and derives a top-left ratio bbox
   from real character boxes. The box is appended only to the Host-resolved Locator.
6. Geometry is fail-closed: no overlay is emitted for absent text, duplicate matches, invalid coordinates, or unsupported
   page rotation. The controlled text rail remains available for accessibility and selection, but citation focus does not
   highlight it when a verified original-page bbox exists.
7. The Reader draws the verified bbox over the authenticated PDFium page bitmap. Document, revision, representation
   hash, physical page, and resolved Locator must all match the displayed page. A page number or nearby text alone never
   produces a box.

## Consequences

- A first-turn `@PDF` question creates no dead “please bind Source Scope” loop; the explicit user action is executed
  before the model sees the message.
- Scope expansion remains explicit and auditable. Free prose, filenames without `@`, Search results, and model requests
  cannot add a source.
- Citation verification now occurs visually on original PDF pixels for supported born-digital pages. Scanned, rotated,
  ambiguous, or textless pages retain the honest page/text fallback without fabricated coordinates.
- PDF visual-line segmentation produces finer evidence blocks and new stable block/Locator IDs while preserving the
  immutable source revision and representation content hash.

## Required verification

- parser tests for supported, quoted, duplicate, missing, and ambiguous references;
- authenticated Library reuse/import plus Source Scope patch must finish before Conversation send;
- draft retention and zero Agent admission on preflight failure;
- exact reused documents rebuild when the sidecar index specification changes;
- born-digital PDF line blocks resolve to bounded real ratio boxes; duplicate text and rotated pages produce no box;
- Reader overlay identity checks, original-page highlight, and absence of simultaneous text-rail marks;
- live `@DocAtlas-Harness/data/sample_report.pdf` first-turn summary with citations and Q4 page-2 highlight.

