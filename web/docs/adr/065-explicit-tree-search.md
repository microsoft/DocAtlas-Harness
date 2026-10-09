# ADR-065: Explicit, bounded query-driven tree search

Status: Implemented and locally accepted under the user-approved ADR-064 scope.
Date: 2026-10-09. Real-model/corpus quality is not established by fixture acceptance.

`product-search.v1` is separate from `sidecar-document-rpc.v1`. The recipe
`tree-search.v1` opts into query-driven routing. Absence of a recipe retains the
old Search path (including the old combined behavior); default FTS stays local.
The Pi tool exposes the new recipe explicitly, without renaming original Pi tools.
Selecting the newly supported Pi `strategy=tree` itself also opts into this
recipe; legacy sidecar tree remains unavailable, and old combined calls do not
gain model effects without a recipe or an explicitly consumed question policy.

The product-control v1 submission receives one optional, strictly parsed
`documentSearch: { recipe: 'tree-search.v1', strategy }` object. Absence preserves
old behavior. Its entire body is already covered by the original durable request
hash/outbox; retries cannot replace it with current UI settings. Only exact native
consumption installs the policy, and host execution applies it even if a model
omits the recipe or proposes another strategy. It does not alter sources, user
text history, actor/profile identity or the database schema. The browser choice
is local to the current conversation and disabled while its outbox is uncertain.

Core routes a fixed consumed submission's authorized source snapshot. It builds/
reuses immutable raw navigation through the existing worker, collects a bounded
catalogue across all selected sources, and reports catalogue truncation. A single
host model transformation selects up to 16 known catalogue keys and reasons.
Model-proposed IDs/pages/hashes are not authority. Every selected key is resolved
back to the same verified tree generation and source; duplicate/unknown keys fail.
No summary job or Python model call is launched. Tree leads have empty blockIds;
Read page/blocks remain the only route to attested source Evidence.

An optional read-only summary port reuses up to 50 nodes from an already completed,
independently sealed overlay with the exact base generation/tree hash and active
source/representation. Merged/expanded nodes are never guessed onto raw node IDs.
Only matching nodes' bounded summary excerpts enter the catalogue; their original
job/result hashes are included in the execution input hash and `summaryRefs`.
Missing overlays leave title/keyItem routing available, without starting a job.

Combined executes both FTS and tree routes and uses rank-based merging with
source/revision matching; it does not add model confidence to BM25 or disguise a
failed tree route as successful fusion. Whole-operation timeout and caller abort
join real model work. Queries/cursors are scoped to recipe, limits, current
submission, source identities/hashes and model identity. A bounded ephemeral
result snapshot provides stable pages; expiry requires a new explicit search,
never an automatic model replay or second durable research content store.

Keep successful Read receipt / checkpoint / Answer publication lineage unchanged.
Search is auxiliary execution, not answer-generation MemoryUse or an invitation.
Source revocation and frame changes are checked after asynchronous work and on
every cached page. No public route accepts host model configuration or source paths.
