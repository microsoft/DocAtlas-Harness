# PageIndex / SDK follow-up: versions, scope and the next useful optimizations

> Read-only upstream audit: 2026-09-09, Batch25. No source pin, dependency,
> generated vendor, product code or paid/model call changed in this audit.
> This supplements [02](02-pageindex-sdk.md) and [18](18-pageindex-flash-adoption.md);
> the implementation authority remains [the living plan](../docs/implementation-plan.md)
> and ADR-026/038/051. Sections 1–3 and the audit-method record retain that read-only
> audit's provenance. Candidate A was subsequently accepted and implemented in
> Batch26 under [ADR-053](../docs/adr/053-bounded-parallel-flash-enrichment.md), with
> focused verification on 2026-09-10; B/C and the stated quality/recovery gates
> remain proposals or open acceptance work.

## 1. No new source upgrade; release metadata needs a correction

| Surface checked online | Observed identity | Meaning for this workspace |
| --- | --- | --- |
| PageIndex `main` | `ae169566b3148792776531d987f543edcad92321` | Exactly the existing source lock; no new main changes |
| Latest stable Python GitHub/PyPI release | `0.2.15`, published 2026-09-06; tag resolves to `d0d6aa39e8035691be9982718839e327f24f83af` | Already an ancestor of our current pin, not an upgrade to perform |
| Python source `pyproject.toml` | `0.2.10` | A release-build placeholder, **not** the latest published SDK version |
| JS SDK `main` | `9925e8a347a9985424f4bb4e95718a75814b9b67` | Exactly the existing source lock |
| npm `@pageindex/sdk` latest | `0.8.0`, published 2026-03-24; `gitHead=32b4dfc626c968a23887637f3f86c5cf40e88bc6` | Published artifact is older than the inspected main source |

The Python [publish workflow](https://github.com/VectifyAI/PageIndex/blob/ae169566b3148792776531d987f543edcad92321/.github/workflows/publish.yml)
explicitly injects the git tag's version into the placeholder during the release
build. Older research labels quoting `pyproject.toml` must not be interpreted as
the published version. Remote `v0.3.0.dev3` is a July development tag, not a new
stable release after September's `0.2.15`.

Local ancestry/diff inspection confirms that `0.2.15` → our main pin changes
README and chat-process image-payload display/tests, not `pageindex/flash`,
`tree_optimize.py` or `utils.py`. Therefore this audit supplies no evidence of a
new Flash algorithm or additional speedup over the already reviewed pin.

There is also a packaging distinction on the JS side: main has added
`browseDocuments`, `getFolderStructure`, `searchDocuments`, updated removal
shapes and removed an undocumented upload `mode` since the npm `0.8.0` release.
These changes were already present in our pinned research checkout. Installing
`@pageindex/sdk@0.8.0` would not automatically provide all of that inspected
main surface. A future dependency decision must pin/test the actual published
artifact rather than assume unchanged `package.json` means unchanged API.

Public version evidence: [Python release](https://github.com/VectifyAI/PageIndex/releases/tag/v0.2.15),
[PyPI metadata](https://pypi.org/pypi/pageindex/json),
[npm metadata](https://registry.npmjs.org/@pageindex%2fsdk).

## 2. Scope is not interchangeable across SDK surfaces

Two early statements in research/02 need narrowing: “doc_ids is a hard
allowlist” is true for the Python **local tools**, not every cloud path;
“folderScope limits all operations” is not established by the JS implementation.

| Actual source behavior | What DocAtlas must retain |
| --- | --- |
| Python local `agent_tools(doc_id=...)` enforces a tool-layer allowlist and rejects empty selections | Exact product Source Scope still owns admission, revision and permission |
| Python cloud `agent_tools(doc_id=...)` refuses; own-model chat over cloud documents has prompt-level targeting only | Never replace a product authorization check with a model instruction |
| Python cloud agent tools discover the live MCP tool set; read-only endpoint is the default, management requires an explicit different surface | Do not automatically register unknown remote tools or inherited management authority |
| JS MCP puts `X-Folder-Scope` on its transport | This is an upstream scope request, not proof of DocAtlas actor/workspace/revision policy |
| JS REST uses `folderScope` as the default `folder_id` for submit/list; get/tree/delete do not send a corresponding scope header | Apply host-side document allowlists and reauthorization to every operation |
| JS `setFolderScope()` changes the MCP transport only; REST keeps its constructor-time scope | Do not use one mutable SDK client as cross-conversation source authority |

These are static code observations, not a penetration test or a claim about
the remote server's account-level authorization. Relevant fixed sources:
[Python scope guard](https://github.com/VectifyAI/PageIndex/blob/ae169566b3148792776531d987f543edcad92321/pageindex/agent_tools.py),
[Python client](https://github.com/VectifyAI/PageIndex/blob/ae169566b3148792776531d987f543edcad92321/pageindex/client.py),
[JS client](https://github.com/VectifyAI/pageindex-js-sdk/blob/9925e8a347a9985424f4bb4e95718a75814b9b67/src/client.ts),
[REST implementation](https://github.com/VectifyAI/pageindex-js-sdk/blob/9925e8a347a9985424f4bb4e95718a75814b9b67/src/api/client.ts),
[MCP transport](https://github.com/VectifyAI/pageindex-js-sdk/blob/9925e8a347a9985424f4bb4e95718a75814b9b67/src/transport.ts).

Cloud remains a separate opt-in provider and data-egress decision. A remote
document name, block ID, image path or citation is not yet a DocAtlas immutable
revision, verified Locator or successful native Read receipt. SDK interfaces
are not a reason to add another chat loop, expose credentials to Python or
silently upload a local PDF when local parsing cannot handle it.

## 3. What the current blog/benchmark does and does not establish

The [Flash blog](https://pageindex.ai/blog/pageindex-flash) is dated 2026-08-26.
It describes local layout-based extraction, optional model indexing work and
separate retrieval models. Its example timings/costs concern that measured
SDK workflow, not DocAtlas's sandboxed raw-only ready time. “Local” does not
mean source text stays on the machine when summary/expand/chat uses a remote
model. The blog itself excludes OCR from the local parser.

The linked [OSS benchmark](https://github.com/VectifyAI/PageIndex-OSS-Benchmark/tree/ad4c0b92970a6f4801f09ff2e647389e8f5874fa)
was inspected at main `ad4c0b92970a6f4801f09ff2e647389e8f5874fa`:

- 62 questions, 34 PDFs, 1,945 pages; answers are facts in running text.
- No table/chart/figure understanding, counting or arithmetic tasks.
- Documents Flash refuses are explicitly excluded, not counted as failures.
- Chat configurations reuse the same indexed trees; reported question costs
  exclude the shared one-time indexing cost.
- The judge compares reference and answer, without reading the PDF. Semantic
  answer equivalence does not prove exact evidence support or PDF highlighting.
- Its README runner uses an earlier protocol spelling. It is a method reference,
  not a drop-in product harness, and was not executed in this audit.
- GitHub returned no detected license and the root tree had no LICENSE file.
  Check dataset/document rights and any separate terms before copying fixtures
  or code; do not assume PageIndex's MIT license covers this separate repository.

The useful evaluation idea is a **fixed-document, fixed-question comparison**,
with indexing cost amortized separately from query cost. It should be extended,
not reported as DocAtlas quality: include rejected/empty documents, CJK, tables,
multi-column and scanned inputs, and measure exact-source citation behavior.
The existing same-hash synthetic numbered-heading gates remain valid regression
evidence; rerunning them does not supply this missing real-corpus evidence.

## 4. Concrete candidates and subsequent implementation

### A. Bounded parallel enrichment, not an SDK wholesale transplant

The retained v1 [Core enrichment](../packages/core/src/document/enrichment.ts) executes
eligible expansions sequentially and awaits each child summary sequentially.
The upstream optimizer uses a ready frontier with expansion concurrency 32 and
summary concurrency 64. That is useful evidence of independent work, not a safe
product default; DocAtlas's host provider already has a stricter shared cap.

A bounded scheduler is now implemented as the explicit
[`docatlas-flash-enrichment.v2` recipe](../packages/core/src/document/enrichment-v2.ts)
under [ADR-053](../docs/adr/053-bounded-parallel-flash-enrichment.md). It permits at
most two independent calls in a stable batch without changing the Agent Loop.
The host's shared provider cap remains authoritative; Core cannot inspect free
host slots and does not claim to schedule against remaining host capacity.
The review prerequisites are implemented as follows:

1. Reserve whole-job calls, input characters and **worst-case in-flight output**
   before dispatch. V2 uses one budget bank across expansion and summary,
   evenly splits floor output reservations subject to per-call caps, and falls
   back to one call when two cannot fit. Short excerpts consume that same
   output-scalar bank. The serial v1 algorithm remains unchanged.
2. Expand only independent frontier nodes; summaries follow a child-before-parent
   dependency order. Commit nodes/decisions in deterministic source order, not
   response-arrival order; retain deterministic IDs and immutable base trees.
3. One failure/expiry/revocation stops new dispatch and joins every actual
   outstanding provider before capacity or ownership is released. No hidden
   retry ladder, partial overlay publication or second transcript.
4. Focused tests cover reversed completion, shared-budget exhaustion, one
   failed sibling, abort during dispatch, source changes and held providers
   that ignore abort. Multi-level summaries match the serial scripted
   semantics; response arrival order does not change result hashes.
5. Optional request `recipe` makes the identity explicit: absent recipe and
   old jobs retain v1; new Web requests explicitly choose v2. Both versions
   persist/replay with their own seals, and same-key cross-recipe changes
   conflict. No old generation is relabeled and enhancement is not the ingest
   default.

Batch26 source tests passed **20/20** and host/runtime tests passed **13/13**;
the exact commands and coverage are recorded in ADR-053. Controlled tests
observe peak concurrency **2 versus serial v1's 1**, not a measured elapsed-time
speedup. Real host tests use generated PDF bytes, actual immutable ingest and
document namespaces with controlled provider promises; capacity/ownership is
released only after every provider and the actual document namespace join.
These are scheduling, contract and lifecycle results, not paid-model quality
or real-corpus acceptance. The final whole-repository/browser checks remain
integration-owned and pending at this note's update. Source/vendor pins remain
unchanged; normal PDF Read does not depend on running an enrichment job.

### B. Real-corpus/full quality with an auditable cost envelope

The raw/merge provider, explicit summary/expand/full jobs and bounded read-only
`docatlas_enrichment` already exist. The remaining gap is **quality and measured
benefit**, not missing tool registration. Start with a small rights-cleared real
corpus and the same source hashes/questions across legacy, raw, merge and full.
Separate no-model admission/navigation tests from opt-in model runs; freeze the
model/config, budget and judging rubric before calling a provider.

Report ingest readiness, CPU/RSS, navigation/page/block recall, tool bytes,
unknown/empty outcomes, original-PDF evidence resolution, latency and total
index-plus-query usage. A smaller routing cost is only an internal structural
metric; summaries can still omit decisive caveats. Add human checks for omitted
exceptions/units/date ranges and generated-but-unsupported summaries. Default
provider selection should follow capability/quality evidence, not the blog's
best-case benchmark or a single synthetic success.

### C. Capability/egress clarity before any optional cloud adapter

Expose a host-owned capability distinction for text-only local parsing versus
OCR/images/cloud corpus services, without advertising unimplemented features.
Keep fallback explicit: “this document has no usable text layer” should invite
an authorized alternative, not send data elsewhere automatically. Any future
SDK adapter needs an immutable provider→DocAtlas identity mapping, output
validation/size limits, per-operation policy checks and a reviewed cancellation
contract. The JS SDK's TypeScript casts and first-text/first-image selection are
not a substitute for product wire validation or bounded multi-part content.

Job continuation after an unclean stop, result retention/administration and
model-quality acceptance remain separate work. None is solved by switching to
the upstream default `full + summary` call or its retry/concurrency settings.

## 5. Original Batch25 audit method and verification scope

Executed read-only `git ls-remote` for the two pinned repos and the public
benchmark, fetched public GitHub release/PyPI/npm metadata and blog/SDK text,
and inspected local pinned sources plus product enrichment implementation.
`bash scripts/verify_sources.sh` passed for every pinned checkout. Local git
ancestry and targeted diffs established the release relationships above.

During that read-only audit, no `git fetch`, source checkout mutation, benchmark asset download, package
installation, model call, generator or shared build was run. This is an audit,
not a test of live PageIndex Cloud or a new product-quality result. The later
Batch26 local implementation and focused checks are separately identified in
§4A and ADR-053; they do not alter this upstream audit's evidence or imply a
new upstream/vendor version. Root owns the integration `scripts/check.sh`;
this documentation lane does not race it.
