# ADR-001: Runtime ownership

> Status: Superseded for the new product by [ADR-021](021-docatlas-first-pi-runtime.md); retained for the legacy DSH implementation
> Date: 2026-08-30
> Owners: DocAtlas domain and DSH integration

## Context

The upstream DocAtlas harness includes its own Python Agent loop, Azure client, session file, four Skills, TUI, and
post-Note memory hooks. DeepSeek Harness already owns model routing, the durable Session log, tool execution,
approvals, cancellation, steering, and the Web shell. Running both control planes would create two histories, two
cancellation semantics, hidden model calls, and ambiguous authority over user-visible state.

At the same time, DocAtlas has valuable Python-native document capabilities: PDF/Markdown processing, PageIndex
navigation, block extraction, table/figure handling, rendering, and future OCR/provider integrations.

## Decision

### DSH owns execution

DSH is the only owner of:

- Agent construction and the model/tool loop;
- model credentials, provider routing, retries, token accounting, and reasoning configuration;
- Session messages and standard tool call/result events;
- approval, steering, cancellation, resume, and unknown-outcome handling;
- the application shell, resident composer, conversation views, and Trajectory.

Every model-assisted rerank, candidate extraction, challenge, review, or background analysis must be invoked through
DSH and visible in its trajectory. A DocAtlas tool may not call a hidden auxiliary model inside the Python process.

### The `docatlas-dsh` Host plugin owns orchestration

The TypeScript Host plugin owns:

- DocAtlas tool registration and conversion between DSH tool calls and domain commands;
- source-scope, identity, policy, and permission admission;
- sidecar process lifecycle and version/capability negotiation;
- Investigation Journal and domain transactions;
- Research Recall and Tree Overlay projections;
- Personalization policy, admission, decision compilation, and authenticated user commands;
- authenticated RPC/streams and exact Fetch routes for the Client;
- projection of domain IDs/status into standard DSH tool metadata and Web read models.

The exact SQLite file split is deferred to ADR-003. Logical domain boundaries are not deferred.

### Python is a document sidecar

The Python sidecar owns:

- document ingest and provider capability detection;
- immutable source revision/representation metadata supplied to the Host;
- PageIndex/tree generation, block maps, FTS, progressive Search/Read;
- PDF page/figure rendering, text quality, OCR and table extraction;
- locator resolution and re-anchor candidates;
- bounded document-processing caches.

It does not own conversation state, personal memory, Claim review decisions, model credentials, or another Agent
loop. It receives opaque IDs and approved source bindings from the Host rather than arbitrary browser paths.

### The Client is a projection and command surface

The browser Client:

- registers additive DSH slots and consumes authenticated read models;
- holds only transient presentation state locally;
- sends typed commands with last-seen versions/nonces;
- never talks directly to the Python process or opens arbitrary server filesystem paths;
- never becomes the durable source of Evidence, Claim, Note, Review, Artifact, or Memory state.

### Cross-boundary contracts

`contracts/` is the language-neutral source of truth. Breaking changes create a new protocol/schema version with
explicit negotiation or migration behavior. DSH Session Log and DocAtlas Investigation Journal cross-reference
session/turn/call IDs and domain IDs/hashes without copying each other into a second truth.

Domain writes are durable before a successful tool result returns. A DSH result that references a missing domain
object is an integrity error; an unreferenced domain write is an auditable orphan eligible for bounded recovery.

## Consequences

### Positive

- one observable Agent loop and one cancellation/approval model;
- document code remains in the ecosystem where it is strongest;
- Web authentication and user commands stay next to DSH Connection;
- Research and Personalization can evolve without teaching Python about browser/session identity;
- model work cannot be hidden inside a nominally deterministic tool.

### Costs

- Host ↔ sidecar contracts and process lifecycle require explicit engineering;
- some upstream Python Agent/Skill code becomes reference or compatibility code rather than direct product code;
- long operations need cancellation, restart, idempotency, and projection across two processes;
- domain persistence requires an additional journal beside the DSH Session log.

## Rejected alternatives

1. **Run the upstream Python Agent loop inside a DSH tool.** Rejected because the nested loop hides models, cost,
   cancellation, and intermediate state.
2. **Move all PDF/PageIndex code to TypeScript.** Rejected because it discards mature Python capabilities without a
   product benefit.
3. **Let the browser call the sidecar directly.** Rejected because it bypasses DSH authentication and Host policy.
4. **Store all domain state in DSH Session events.** Rejected because current persisted event vocabulary is closed and
   human UI mutations need domain transactions/migrations independent of chat history.
5. **Use browser local storage as the workspace.** Rejected because clearing a browser must not delete research truth.

## Verification

- architecture tests reject model credential configuration in the sidecar;
- plugin tests prove tools and authenticated routes are disposed with their Host fiber;
- sidecar protocol tests negotiate service/protocol versions before document calls;
- browser tests prove opaque IDs cannot escape configured source roots;
- trajectory tests show every model-assisted DocAtlas operation as a DSH-visible step;
- cold-replay tests rebuild Web projections from Session + Journal without Client state.
