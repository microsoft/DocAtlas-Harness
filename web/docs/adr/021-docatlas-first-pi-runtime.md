# ADR-021: DocAtlas-first product with an embedded Pi runtime

> Status: Accepted — target architecture; implementation migration is pending
> Date: 2026-09-08
> Basis: user explicitly chose DocAtlas as the core product, full Pi capability preservation, and reuse of the DSH-era work.
> Supersedes: ADR-001 for the new product; host-specific ownership in ADR-003–010 and ADR-020 as described below.

## Context

The workspace is no longer a wrapper around the original four DocAtlas Skills. It contains language-neutral contracts,
source identity, Evidence/Claim/Review/Artifact semantics, Investigation and Personalization ledgers, research continuity,
progressive reading, selection transactions, and a substantial Web interaction plan. These are product assets, not
incidental plugin features. The DSH Web shell and document-only preset do not meet the current product goal.

Pi v0.85.1 exposes its full coding-agent session through an SDK. Source review confirms native tools, resource loading,
session branches, compaction, retry, steering and extension hooks can be composed by an application. It does not provide
DocAtlas domain ownership, our Web experience, or a complete product authorization boundary.

## Decision

### DocAtlas is the application and domain owner

DocAtlas owns startup/composition, workspaces, investigations, source admission, Evidence, claims, research state,
personalization, workflow policy, approval records, run coordination, browser APIs, and Web interaction. The product
starts DocAtlas services and embeds Pi; it is not defined by installing an optional extension into a user-owned Pi shell.

`packages/core` contains the host-independent domain/application services and their ports. `apps/server` composes them
with `packages/runtime-pi` and Python document services. `apps/web` owns the product interface. Internal use of Pi's
supported tools/hooks is an adapter mechanism, not the ownership model. An optional native-Pi distribution may follow;
it is not the main product or the owner of domain persistence.

### Pi is the full execution engine, not just pi-ai or a copied loop

Use the published coding-agent SDK/AgentSession runtime as the initial engine candidate, pinned to a reviewed release.
Keep native default tools and user-configured capabilities, trusted AGENTS/Skills/extensions, providers, images,
compaction, retry, steering/follow-up, branches/fork/import/export and session controls. Do not apply the legacy
document-only preset. DocAtlas tools have distinct names; document guidance is task-scoped and additive.

Pi owns its transcript format and internal model/tool loop. DocAtlas owns which authorized run/session is attached to a
workspace and investigation, its interaction/commit lifecycle, and its domain effects. Do not copy Pi's loop or weaken
native capability to simplify a small common-denominator adapter. Pi-specific rich controls stay in the Pi adapter;
Core only depends on the execution/provenance capabilities it actually needs.

One conversation has one runtime writer. Managed child Pi sessions and model-assisted indexing/review jobs are allowed
only with parent linkage, explicit scope, cancellation, budgets, accounting and observed outcomes. This is not an
authorization to run an opaque Python/PageIndex chat loop inside a tool.

### Domain and execution truths remain separate

- Pi transcript: native messages, tool calls/results, branch and compaction history.
- DocAtlas control records: submission/run IDs, runtime binding/generation, acknowledgements, approval and recovery state.
- Investigation journals: source scope, Evidence/Claim/Note/Review/Artifact/Continuity and project decisions.
- Profile ledger: governed personalization, consent, candidates, uses and deletion receipts.
- Python indexes/blobs: revision-bound document representations and rebuildable processing outputs.

A transcript/UI event is not a domain commit. Domain transactions precede successful tool results. Reconnect and
unknown-outcome recovery use stable identities and idempotency, never an automatic re-execution of side-effectful tools.
The first-prompt persistence gap in Pi's stock SessionManager must be resolved before claiming crash-safe acceptance.
The control record is not a second authoritative conversation transcript.

### Full native capability does not mean unrestricted server access

Native shell/file tools remain available within the authorized workspace/process boundary. A SourceScope check only on
DocAtlas tools cannot constrain Bash. Product authentication, document/blob authorization, secret isolation, trusted
resource loading, and high-impact approvals are mandatory. Local/private deployment precedes any multi-user exposure.
Browser input uses opaque IDs, not server paths. Uploaded document text is data, not trusted project instructions.

### Python remains the document engine

Keep and evolve both the product sidecar and the writable downstream `DocAtlas-Harness/` document implementations.
The sidecar does not own a second conversation, model credentials, personal profile or publication authority. Flash raw
indexing can run locally; optional model enrichment must enter the observed runtime job path rather than silently using
PageIndex's default chat/model execution. The original DocAtlas TUI/loop remains a reference and regression surface.

### Web is DocAtlas-owned and progressively disclosed

Default to a centered chat composer. Clicking a citation opens the original PDF beside the same chat and focuses only a
verified original-page region. Users may open PDFs proactively. Multi-document organization, Compare, selection Ask,
Notebook, Claim/Review/Publish and Personalization remain first-class capabilities, revealed when relevant rather than
occupying a mandatory dashboard. Native activity, code/diffs/artifacts and runtime controls remain accessible.

## What is superseded, and what is retained

| Previous ADR | New-product interpretation |
|---|---|
| 001 | DSH/product ownership replaced by DocAtlas application + Pi engine. Python/no-hidden-loop boundary retained. |
| 003 | Product-owned journals replace plugin ownership; logical/physical separation, CAS, audit and backup retained. |
| 004 | Supervisor policy retained; DSH subprocess implementation becomes an adapter, not a Core dependency. |
| 005 | DSH Connection is legacy-only. New authenticated product transport needs a reviewed contract/security slice. |
| 006/007/010/020 | Preserve atomic selection and explicit source admission; move admission to all server submission paths. |
| 008/009/017/020 | Preserve exact source focus, cursor independence and grounded answer rules; replace DSH-specific seams. |
| 002/011–015/018/019 | Domain meaning retained. Host/Session references need explicit identity adapters, not silent field renames. |

All existing DSH runtime contracts remain valid for the legacy implementation. This ADR does not reinterpret its data,
change wire fields, migrate databases, or claim the Pi Web implementation exists.

## Migration and verification

See the [master plan](../implementation-plan.md), [module inventory](../migration/dsh-to-core.md),
[runtime design](../architecture/pi-runtime.md), and [Web specification](../product/web-experience.md).
Migration proceeds through reviewed contracts, extraction tests, Pi parity, real mixed-task/browser acceptance and
backup/recovery gates. Retain the DSH implementation until those gates pass; no destructive data or directory move.

## Rejected alternatives

1. DocAtlas is merely an optional Pi extension: does not give DocAtlas product/domain ownership.
2. Replace Pi's native tools/prompt with a document-only agent: loses the requested general capabilities.
3. Fork/copy Pi wholesale immediately: adds upstream maintenance without demonstrated need.
4. Rebuild from the original DocAtlas only: discards the DSH-era domain and product work.
5. Treat tests/empty folders as a shipped Web product: fails the user's actual acceptance criteria.
