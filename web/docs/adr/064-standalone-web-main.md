# ADR-064: Independent Grounded Web in official Harness main

Status: Implemented and locally accepted within the bounded migration scope
(2026-10-09). No remote push or public deployment is included.

The user approved migrating the final video Web product into the official
DocAtlas-Harness repository as an independent application. The Python CLI/TUI,
benchmark defaults, root pyproject/lock, and supported Python versions remain
unchanged. Web/CLI score, token and latency equality is explicitly not a gate.
The progressive Read, PDF identity, immutable Flash, research journals, Evidence
and verified original-PDF grounding are intended product capabilities to retain.

## Repository and ownership

Use a clean official-main integration branch, with the product under `web/` and
its own Node/pnpm and Python/uv environment. Preserve internal apps/packages/
contracts/python layout. The root launcher is a thin explicit opt-in forwarder;
ordinary Python installation/import never downloads or launches Node. Core
remains independent of Pi/DSH/React; Python remains a document-only sidecar.

Migrate the complete live dependency and test closure, not only React. Preserve
legacy DSH in the original workspace; do not ship it as a new Web dependency.
No experiments from either standalone Python checkout are implicitly merged.
Record source file hashes and deliberate packaging adaptations. Keep source,
patch, generated-vendor and upstream provenance separate. Frozen installs and
actual packaged-sidecar verification remain gates of the independent build.

## Search

Add an explicit versioned product recipe for `fts`, `tree`, and `combined`, with
FTS as the default. Legacy sidecar v1 is unchanged: its `combined` must not
silently acquire model effects. Query-driven tree selection is a bounded host
ModelRuntime auxiliary call, not a Python credential/Agent Loop or generated
factual answer. Core owns orchestration through ports. Validate known nodes,
source/revision/hash and immutable tree generation before and after async work;
derive page ranges from the verified tree, never from model assertions.

Tree nodes are not block IDs. Return section leads and use original Read for
Evidence. Existing completed summary overlays may assist navigation, but Search
does not implicitly launch enrichment. Combined actually merges independent
routes, preserving provenance and honest partial/error states. Pagination binds
the query/strategy/source/recipe snapshot and does not rerun a model silently.
Cancellation, budgets, broker caps and real provider joins remain mandatory.
Auxiliary search is not answer-generation MemoryUse or a publication transition.

## UI and data

The user also authorized typography/color/layout improvements referencing
https://officeintelligence.github.io/. Use warm paper, ink/green editorial tokens,
legible bilingual typography, restrained accents and responsive work surfaces;
retain citations, draft/outbox identity, Notes/Review and original-PDF actions.
Do not copy site content/assets without reviewed permission or use fake answers.

Keep loopback-only login-free local access, exact Host/Origin/CSRF and server
identity. New launch uses separate state; migration does not move live databases.
Current actor/workspace derive from the absolute state root: relocating existing
state is a separate identity/recovery operation, not a folder cleanup. No dual
writer, guessed claim clearing, transcript reconstruction or public exposure.

## Gates

Original Python package/CLI tests; independent frozen Web build/check and sidecar
wheel verification; real PDF browser journeys (including returned highlights,
selection/notes/map and refresh); native cancellation; genuine tree routing and
invalid-node/source/cursor/cancel cases; desktop/mobile bilingual accessibility.
Retain known baseline failures as failures until diagnosed and repaired, never
delete assertions or relabel fixtures as model-quality/performance reproduction.
See the canonical plan and `docs/migration/main-web.md` for current evidence.
