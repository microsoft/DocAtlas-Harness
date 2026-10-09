# ADR-038: Explicit Flash summary/expand jobs

> Status: Internal implementation; default-provider/corpus/deployment acceptance remains open
> Date: 2026-09-09

Flash raw/merge generations stay immutable and usable independently. Product-owned enrichment jobs create separately
identified navigation overlays: summaries and proposed child sections are not Evidence and do not change source IDs,
canonical node IDs, original PDF or FTS. The recipe is independently versioned, informed by pinned PageIndex Flash
`tree_optimize.py` and `utils.py`, not claimed to be a byte-identical invocation of the upstream default API.

An authenticated explicit request identifies the conversation binding, source revision, base mode, selected native node
IDs, enhancement mode and hard budgets. A private durable job claim precedes preparation and each job records generating
before a model can be called. Concurrent lookups share the job; completed retries return the same result. Unclean preparing/
generating claims are never automatically stolen/replayed on PID/TTL guesses. Queued jobs can be explicitly started after
reopen. Cancellation and shutdown join the actual document processes AND provider result before releasing capacity.

Python only supplies verified deterministic trees and cache-only page text. Model execution uses the Pi ModelRuntime in
runtime-pi as a tools-free, bounded one-shot transformation, not another AgentSession/Agent Loop and not Python credentials.
Jobs have conversation/native-session lineage but do not append assistant answers to the conversation transcript. The
host chooses the configured model; browsers cannot supply providers, endpoints, credentials, system prompts or tools.

Core owns the enrichment recipe: recursively expand eligible collapsed nodes only when proposed headings occur on their
pages, ordered ranges fit the parent and routing-plus-worst-scan cost strictly improves; preserve parent residual pages.
Reject malformed proposals, never repair model JSON into authority. Summaries run bottom-up using source text/child
navigation summaries. Every output is labeled navigation-only with source/base/input/result hashes and model usage.
Unicode-aware matching avoids the upstream ASCII normalization losing Chinese headings. Conservative page overlap is
retained; neither inferred structure nor summaries can supply quotation geometry.

`docatlas_enrichment` is a read-only Pi tool: without a job ID it lists completed current-source overlays, with a job ID
it reads whole nodes in a bounded page. The `enrichment-list` / `enrichment-page` contracts pin scope, source revision,
original/representation hashes and overlay seals. Recheck the exact active DocumentSession invocation after asynchronous
lookup. Staging another submission or previewing/enriching a Library document cannot activate its source frame. Changed
representations are rejected/omitted, queued jobs are never started by navigation, and this tool does not replace Read.

The live drawer handles a valid empty Flash tree separately: no detected outline is not no document text. It disables
node enhancement and explains the limitation; FTS/Read remain independent. Short source-excerpt summaries may correctly
use zero model calls; model-backed browser verification uses a real PDF with embedded outline and longer body text.

Hard page/node/call/input-character/output-token/output-byte/wall budgets apply to the whole job, not independently reset
per node. No default fan-out of 32/64 model calls and no hidden retry ladder. Empty/no-gain expansion is an explicit retained
collapsed decision, not a failed raw index. Insufficient budget or unreadable text reports a failed job without publishing a
partial overlay. Whole-corpus evaluation, OCR/multilingual cases, incremental job continuation/retention administration,
automatic default selection and full release acceptance remain separate R5/R7 gates.
