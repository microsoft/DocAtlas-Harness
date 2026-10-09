# Wire contracts

This directory is the language-neutral source of truth for DocAtlas process and durable JSON. Schemas use JSON Schema 2020-12 and have explicit protocol versions.

The DocAtlas-first/Pi target in ADR-021 preserves these domain contracts. Existing DSH-specific bindings remain legacy
wire behavior; product run/session/branch/submission and browser transport changes require separate contract review.
No schema/version/field meaning changed as part of the 2026-09-08 folder reorganization.

Subsequent backend implementation adds independent `product-control.v1` for bindings, durable submissions/preparation,
run receipts/transitions and native Pi checkpoints. It does not reuse DSH turn/seq meanings. Shared product fixtures
exercise TS/Python shape and semantic parity. Python gains validation only, not a control RPC/loop. See ADR-024 for
the scoped internal contract and remaining auth/process/transport gates; a schema is not an exposed endpoint.

ADR-050 adds `native-lineage.v1` and optional selected-head/origin fields to history and Answer projections; old JSON values keep their meanings.
The new Web also sends a strong quoted binding ID in `If-Match` on `POST /api/conversations/:id/stop`, whose body remains `{}`.
The authenticated HTTP adapter rejects an outdated binding with the existing 409 `conflict` envelope before cancellation.
Legacy callers without that header keep conversation-current Stop semantics. This header is a binding precondition, not an actor,
workspace, source grant or reconciliation override; malformed/duplicate/wildcard/weak values are rejected. See ADR-050 for the reviewed transport boundary.

The initial health envelope proves the Host ↔ Python process boundary. M0 now also includes canonical protocol/error,
pagination, document revision, representation, source scope, locator, and EvidenceAtom schemas. The catalog at
`schema-catalog.json` is validated by both TypeScript/Ajv and Python/jsonschema against shared fixtures under
`fixtures/m0/`; both bindings also implement the same cross-field semantic checks.

M1 protocol 1.1 adds explicit `capabilities` negotiation. Availability is runtime data: method schemas/types do not by
themselves mean a sidecar advertises or implements that method.
The `sidecar-document-rpc.v1` family defines the ingest/search/read/resolve boundaries. Their capability flags remain
configuration-gated: without approved source roots and cache authority, callers see negotiation methods only.
Its TypeScript and Python bindings are discriminated unions with matching semantic checks, exercised against the same
`fixtures/m1/document-rpc.json` request/result set and JSON-RPC envelopes.

`docatlas-tool-meta.v1` is the bounded presentation payload persisted on DSH's standard `tool/result.meta`; model-facing
excerpts remain in tool content and raw documents/images never enter this metadata contract.

`asset-descriptor.v1` binds an opaque asset identity to immutable document/revision/representation and content hashes,
media facts, bounded visual dimensions, and generator identity. It deliberately has no filesystem or URL field.

`selection-context.v1` is the durable, nonce-free set of exact Locator-bound ranges entering one direct user turn.
`selection-rpc.v1` owns transient stage/prepare/status/cancel plus explicit idempotent action messages. Ordinary staging
and Ask never upgrade a selection; only nonce-authorized `save-evidence`/Note/OpenQuestion/ClaimProposal commands
journal typed domain records, and a ClaimProposal remains distinct from an accepted ClaimVersion.

`research-record-rpc.v1` allows the DSH Agent to append only an unverified checkpoint or Open Question under the
current exact Session/Workspace/Investigation/Scope and tool-call identity. `research-recall-rpc.v1` returns bounded
cross-Session Workspace leads with source-state metadata; every lead is explicitly unverified and cannot substitute for
current Evidence. Paths, full prior Sessions, accepted facts, and Review outcomes are outside both contracts. Decisions
and policy can enter Recall only after creation through the separate authenticated Research Governance contract.

`research-lifecycle-rpc.v1` is an authenticated user command with optimistic versioning for edit, OpenQuestion
resolution, archive, and tombstone. Edits remain unverified; deletion removes the active recall projection while the
audit event remains. It is deliberately not exposed as an Agent tool.

`research-governance-rpc.v1` gives ProjectDecision and ResearchPolicy their own authenticated user-only creation and
CAS lifecycle. A policy's declared investigation/workspace scope is recorded but not automatically inherited or
enforced in M3. `research-notebook-rpc.v1` is the bounded working/same-Workspace query projection over active typed
research records; governance is labeled separately from unverified leads and neither category becomes Evidence.

`tree-overlay-rpc.v1` is the bounded, exact-source read model for Working/current-Investigation and Research/prior-
Investigation anchors. Every item carries an immutable DocumentLocator and means only “this record was anchored here.”
It cannot mutate canonical tree nodes, guess an anchor, accept filesystem paths, or retain a deleted record.

`m4-rpc.v1` is the authenticated Claim Ledger, Artifact and deterministic Review command/query surface. Every request
pins Session, Workspace, Investigation and source-scope identity. Browser drafts omit actors, clocks, lifecycle,
content hashes and rule authority; the Host derives them. Publication requires the exact deterministic review and any
required human decision, while a separate user-authored conflict-search assurance pins the complete sorted Claim and
Evidence sets reviewed under that source scope.

```text
contracts/
├─ sidecar-envelope.schema.json
├─ schema-catalog.json
├─ protocol/
├─ sidecar/
├─ assets/
├─ selection/
├─ investigation/
├─ source-evidence/
├─ tool/
└─ fixtures/m0/
```

The authoritative contract order and milestone gates are maintained in the
[implementation plan](../docs/implementation-plan.md#6-目标领域对象与-contract-顺序). The planned waves are:

1. protocol/error/pagination and source identity;
2. representation, source scope, locator, evidence, selection, and citation focus;
3. investigation, typed research state, recall, and tree overlays;
4. answer segments, claims, review decisions, and artifacts;
5. personalization observations, versions, decisions, uses, and probes.

Rules:

- Existing versioned fields never change meaning.
- New optional fields require producer and consumer tests.
- Breaking changes create a new protocol version and migration/negotiation behavior.
- TypeScript and Python bindings must not accept values the canonical schema rejects at a wire or durable boundary.
- Shape validation is necessary but not sufficient: cross-field and cross-object invariants use matching semantic
  issue codes in `packages/contracts` and `docatlas_dsh_sidecar.contracts`.
