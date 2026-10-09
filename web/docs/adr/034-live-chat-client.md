# ADR-034: Real paired chat client beside the retained prototype

> Status: Internal implementation/browser acceptance; not deployment or complete Reader acceptance
> Date: 2026-09-09

Add a separate live.html entry in apps/web using the accepted chat-first visual language. Keep index.html/DemoApp and
the legacy DSH surface unchanged. Live code calls only authenticated product APIs; no fallback to fixture answers or
simulated timers. Discovery lists only operator-created, actor/workspace-authorized conversations. Conversation creation,
model/branch administration, uploads and original-evidence reading remain explicit subsequent work.

Generate browser validators from the same JSON Schemas, with static code compatible with a CSP that disallows eval.
Validate envelope semantics and actor/conversation/cursor identity on receipt. Buffer bounded observation updates during
snapshot fetch, discard stale generations and refresh on gaps/epochs. A disconnected view does not submit or stop work.
Show committed receipts, provisional generation and checkpoint-backed saved text separately.

Keep an uncertain submission's exact body/idempotency key in this tab's sessionStorage, scoped to the authenticated
actor/workspace/conversation. Never store pairing, cookie, CSRF or model secrets there. Clear an outbox only on a matching
durable receipt, or an explicit user discard/logout. Retry is deliberate and uses the same submission key. Logout clears
the visible session and tab drafts; it does not claim to cancel already accepted server work.

Browser tests serve built live assets under a real loopback handler with an isolated Pi worker and explicitly faux model;
pairing codes are issued directly by the test owner, without a bypass endpoint or default listener. Failed private test
traces may contain credentials valid only for that disposed temporary test service. Tests cover pairing, submission,
reload/reconnect without replay, uncertain outcomes, actual stop, logout, rendering/keyboard/mobile access. These prove the
client transport, not answer quality, complete native parity, durable cold restore or the full PDF/Evidence workflow.
