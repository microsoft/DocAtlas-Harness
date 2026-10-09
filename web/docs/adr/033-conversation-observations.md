# ADR-033: Bounded observations and checkpoint-backed conversation snapshots

> Status: Internal implementation; Web/Reader/release acceptance remains open
> Date: 2026-09-08

Expose authenticated GET conversation snapshot and a single SSE observation stream. Observer state is scoped to actor,
conversation, binding generation and a random stream epoch; sequence numbers are not execution IDs. A bounded replay
window can satisfy reconnects in the same epoch. Missing/old/foreign-epoch cursors trigger explicit snapshot resync, never
submission replay. Malformed cursors fail. SSE disconnection or slow consumers do not cancel or block model/tool work.

Keep committed product receipts, verified native history and provisional text/activity distinct. Snapshot history comes
from the actual file prefix of a verified Pi checkpoint, not serialized worker memory. Select only user/assistant text
and native entry identities; never return thought blocks, provider internals, system prompts or tool arguments/results.
Pending/cancelled/unknown product inputs remain visible through their durable receipts. A history window/large text
excerpt is explicitly bounded and labelled; complete native history/branch controls remain separate work.

Snapshot construction is synchronous at an observation cursor after an authorized runtime lookup. It reads current
control records and the runtime's verified projection, not a second agent loop. Runtime progress has per-submission and
per-message identity. Receipt changes are observed only after commit. Progress may be discarded with resync when bounded
buffers overflow; final saved answers are recovered from the checkpoint-backed snapshot.

Every stream frame and snapshot rechecks the authenticated session and current binding. Logout closes its streams;
heartbeat checks expire idle sessions. Response buffers, replay bytes/counts, subscriptions and live projections are
bounded. No token in a URL, wildcard CORS, unbounded native event forwarding or false saved-success acknowledgement.

This adds internal transport and snapshot APIs, not deployment or automatic document exposure. Source/Reader authorization,
complete history paging, SSE client integration, complete controls and cold restore remain explicit acceptance items.
