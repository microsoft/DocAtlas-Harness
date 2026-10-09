# ADR-027: Portable document application and Pi tools

> Status: Accepted for internal integration; public HTTP/security/quality acceptance remains open
> Date: 2026-09-08

Extract the existing Library application and immutable source-scope binding into Core; extract Node discovery,
asset access and JSONL supervisor into runtime-document. Preserve legacy re-exports, class identity, wire contracts
and durable store fields. A Node adapter package avoids Core depending on DSH and avoids a legacy plugin depending
on a server application. Only platform ports/imports change during extraction; lifecycle improvements are separately tested.

Product source preparation uses the stable product conversation as the logical domain session key. This does not rename
old DSH events or substitute a Pi native session ID. Native session ID/generation remains independently checked against
ControlStore's owner/workspace binding. SourceScopeStore retains immutable scope snapshots, not the current model frame.

Preparing queued input may publish a source snapshot but MUST NOT change the frame of an executing native user message.
The existing exact native-consumption callback activates its prepared scope. Every operation rechecks actor binding,
source eligibility/hash/policy before and after asynchronous work. A late result from a different active frame is rejected.
Empty-source messages clear the active frame. A rebind fences the old native session; no silent reuse of its document authority.

Use distinct document process managers per conversation and a separate Library import process. One conversation's
cancellation must not kill another conversation's reads/imports. Cancellation waits for subprocess exit, including
late startup and one-shot Flash jobs. Visual file reads belong to the same cancellation accounting.

Pi receives additive sources/search/read/tree tools, never replacements for native read/bash/edit/write. Read supports
locate/blocks/expand/sequential/visual plus physical page; images are actual authorized/hash-checked bytes. Flash tree
data is navigation, not Evidence. Existing tool-meta v1 carries read locators; no fake DSH event or evidence receipt is minted.

The new Node process adapter scrubs environment and supervises process groups. It is NOT yet an OS filesystem sandbox
for the entire legacy ingest/read Python process. The nested Flash parser keeps ADR-026 isolation. Public upload/auth,
selection admission, durable Answer/Evidence compilation, Record/Recall, full worker/model boundary and Web acceptance
remain gated. Tests using the real SDK with its faux provider prove execution/identity, not model answer quality.

Verification evidence is recorded in research/23: native mixed-tool/PDF/checkpoint flow, six Read modes, source/policy
and stale-result checks, per-conversation cancel, late-spawn termination, shared Investigation and packaged vendor hashes.
