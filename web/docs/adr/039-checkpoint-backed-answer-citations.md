# ADR-039: Checkpoint-backed product answers and original-PDF citations

> Status: Internal implementation and validation; public deployment/full-format acceptance remain open
> Date: 2026-09-09

The product publishes final citation mappings only after successful, host-attested Read operations can be matched to the
same verified native Pi checkpoint interval. Streaming text, Search/locate candidates, Flash overlays, worker-authored
metadata alone, prior turns and compressed summaries cannot create that authority. Pi remains the only execution loop.

The existing document-call channel carries the native toolCallId on Read. Core's active invocation supplies its own
submission/source frame; callers cannot choose the product submission or actor. The host records the exact validated
ReadResult before returning success. Records pin owner/binding/runtime/generation/submission/scope/native call and a
checked payload seal, with bounded retention. A reused call identity with changed content is rejected. Preserve ReadResult
JSON field order because the native result's first text item must equal the exact returned JSON; use JSON tuple keys,
not embedded NUL TEXT keys (Node 22 SQLite truncates those when retrieving values).

The runtime-pi projector visits the same hash-verified native prefix. It pairs assistant tool calls with successful
docatlas_read tool results and independent host receipts, checks scope/source/representation, tool arguments, details
and returned text, and only then calls the shared Core Answer compiler. Non-conversation Pi metadata is retained and
ignored for evidence; attribution crossing compaction/steering/custom messages currently yields an explicit gap.
`AnswerManifest.messageId` is the native message entry ID; its existing `turn` field is the stable product submission
acceptance ordinal, not a renamed Pi internal turn. Native JSONL is never rewritten by this projection.

Canonical AnswerManifest storage stays in SourceScopeStore. A private publication link pins manifest hash, native text
hash and verified checkpoint; this link commits last. A crash between these stores leaves an unpublished canonical
manifest, not falsely advertised evidence. A linked answer is served only when ControlStore independently records the
same completed checkpoint. Failed citation compilation/publication leaves the completed native answer readable and
citations explicitly unavailable; it does not rerun the model or falsify its checkpoint.

The product-answer response contract adds only readonly answer/focus projections. GET identifies a native message;
POST citation-focus takes an empty object, not paths, client geometry, Locators or claimed source authority. Existing
paired authentication, binding, exact Origin/Host and CSRF apply. Clicks recheck current Library permission and both
representation/original identities using an independent cache-only resolver. Resolve may not select nearby candidates.
Only the same Locator/page/exact quote permits text focus; missing/ambiguous data yields page-only/ambiguous, not Markdown.
Cancellation and shutdown wait for the actual resolver namespace before releasing its bounded capacity.

The browser checks native raw-text hash separately from the manifest's visible-text hash. Only saved, complete history
messages enable citation controls. The original PDF route is constructed from authorized opaque IDs and checks its bytes
hash; the client never accepts a returned arbitrary URL. PDF.js highlights a whitespace-normalized unique quote on the
specified original physical page. Nonunique/missing/unsupported geometry remains explicit without fabricated boxes.
Source support/refutation/qualification is Agent-asserted; locating a quote does not constitute semantic Claim/Review.

Existing 16-citation compiler limits remain visible as gaps; full answer paging, region/table/image localization,
compressed/steered interval attribution, default launcher, real-model corpus quality and full research/personalization
are separate pending gates. Legacy DSH contracts/events/Reader remain compatible; this is the Pi product path, not a mock
or permission to expose unfinished services publicly.
