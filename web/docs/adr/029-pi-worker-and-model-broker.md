# ADR-029: Isolated Pi worker and host-owned effects/model broker

> Status: Internal Linux worker/broker integration implemented; full product acceptance remains open
> Date: 2026-09-08 · implements the preferred worker direction in ADR-023

Run the public, pinned Pi AgentSessionRuntime in its own Linux filesystem/PID/network namespace. Grant approved
runtime/code read-only and its own workspace/session/resources explicitly; do not grant Core/Control/profile/model
credential stores. The agent's native effects go through the existing second-level LinuxExecutor, so native commands
cannot read/write the worker's private transcript or resource configuration. Do not replace original tool definitions.

Use versioned, bounded, directional IPC over inherited pipes. A worker can request authorized native/model/document
effects, never pretend to be a human submission, approval or rebind. Parent authority is captured in the connection's
binding, not accepted from JSON. Unknown methods/IDs, bad ordering, byte/request limits or transport loss fence execution.
Cancellation aborts broker work and waits for worker/native processes; a crashed side-effectful turn stays unknown.

Actual model execution/credentials remain in the host's ModelRuntime. Worker provider metadata is a credential-free
catalog; model IDs/options are rechecked against host policy on each call. No worker-supplied endpoint/header/token or
code callback executes in the host. Preserve actual model events and errors; the broker is not another agent loop.

Runtime control, status and checkpoint operations stay distinct from effects. All Pi control/resource/provider/extension
features remain in scope; expose their authorized adapters incrementally and do not label a prompt/abort-only proxy
as full parity. Extension pi.exec, model hooks/deferred/custom provider bridges, trusted resource approval/snapshots,
background/egress mediation and aggregate resource quotas each require their own acceptance tests.

The proxy distinguishes API/simple streaming. Pi's agent-loop callbacks stay in the worker; provider onPayload/onResponse
hooks use scoped callback IDs, never serialized executable code. Payload hooks cannot override model/credential/routing
fields. Response hooks get status and safe headers, never auth/cookies. Unsupported overrides fail explicitly. Broader
API-specific sampling/custom fetch/env/deferred/provider-registration parity is not certified by this initial proxy.

Checkpoint acceptance verifies the actual private native file prefix/hash/header/entry count/user-to-answer branch,
including when a later turn already appended. Source frames still activate on exact native consumption; parent Core
authorizes document requests and validates actual image bytes. Cancellation waits for model-provider settlement and
native/document quiescence, not merely an IPC cancellation acknowledgement.

First evidence must execute the real SDK in the namespace, use host-side provider/effects, exercise native tools and
saved completion/cancel/crash, and prove absent credential/private-state access. Faux provider tests are explicit and do
not prove model answer quality. No public HTTP endpoint or production launcher is enabled by this ADR alone.
