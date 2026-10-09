# ADR-004: Document sidecar lifecycle

> Status: Accepted
> Date: 2026-08-30
> Owners: `docatlas-dsh` Host and Python document sidecar

## Context

M1 moves progressive document processing behind the DSH plugin. The upstream harness currently launches each Skill as
a short-lived Python subprocess against a shared session JSON file. That model repeatedly imports heavy PDF libraries,
cannot maintain an ingest-time block index, has weak cancellation, and lets individual scripts own persistence.

A long-lived worker improves latency and cache reuse, but it must not become a second application server or Agent. The
Host remains responsible for browser authentication, source authorization, model execution, domain transactions, and
user/session identity.

## Decision

### One supervised process per Host plugin instance

The Host plugin starts one local Python sidecar process and multiplexes approved document work over stdin/stdout JSONL
JSON-RPC. The first release does not expose a TCP port and does not start one process per browser Session or document.

```text
stopped
  → starting
  → negotiating (health + capabilities)
  → ready
  → draining
  → stopped

starting/negotiating/ready
  → failed
  → bounded backoff
  → starting
```

The process belongs to the Host plugin fiber. Plugin disposal stops new requests, cancels/drains bounded work, closes
stdin, waits for the configured grace period, and then terminates the child if necessary.

### Protocol negotiation before use

`health` proves service identity and exact envelope version. `capabilities` reports:

- supported protocol range and document RPC versions;
- methods and progressive Read modes;
- provider/representation capabilities;
- configured limits and concurrency;
- build/package identity.

The Host refuses document calls until negotiation succeeds. An unknown major version fails closed; compatible optional
capabilities are feature-detected rather than assumed from package version.

### Process I/O contract

- stdout is JSONL protocol only; diagnostics go to stderr;
- every request/response has a non-empty Host-generated request ID;
- Host validates outgoing params and incoming results against canonical generated contracts;
- malformed stdout, duplicate response IDs, unknown response IDs, or protocol version drift fail the generation;
- stderr is bounded/redacted and never parsed as a successful result;
- large PDF/page/figure bytes are file/cache bindings or content-addressed assets, not base64 JSONL payloads;
- browser paths/URLs never reach the sidecar directly; the Host resolves and authorizes a source binding first.

### Concurrency and backpressure

The sidecar supports bounded concurrent read-only work and a smaller bounded ingest/render pool. Capabilities advertise
limits; the Host maintains a queue and returns structured limit/cancel errors rather than spawning unbounded processes.

Per-document ingest is idempotent by revision/representation identity. Cache publication is atomic: incomplete work is
written to a temporary entry and becomes visible only after content hash and metadata validation.

### Cancellation

Client/DSH cancellation reaches the Host as an AbortSignal. The Host sends a protocol cancellation control for the
target request and stops accepting its late success as an ordinary result. Python operations check cancellation at
bounded points between pages/blocks/provider stages.

If a library call cannot be interrupted safely, the request remains `cancelling` until it returns or the Host kills the
generation after policy timeout. Process termination cannot leave a published partial index.

### Restart and unknown outcomes

- Search/Read/resolve are read-only and may retry after a new negotiated generation when their source revision remains
  available.
- Ingest/render use idempotency keys and inspect cache/domain state before retry.
- A request written to stdin without a valid response is an unknown outcome, not an assumed failure.
- Every process generation has an opaque generation ID; late output from an old generation is rejected.
- Backoff is bounded and reset only after a stable ready interval; repeated crash loops surface operator diagnostics.
- The Host projection reports unavailable/restarting/degraded state without blocking unrelated DSH Chat functions.

### Filesystem and credentials

The Host supplies only approved source/cache bindings under configured roots. The sidecar enforces containment again,
does not expand browser-controlled environment variables, and does not read arbitrary working-directory paths.

The sidecar receives no Azure/OpenAI/model credentials. Document-provider credentials, if later needed, use a separate
capability and minimum-scope credential channel; they are never placed in request logs or durable fixtures.

## Consequences

### Positive

- persistent block/FTS indexes and warm PDF libraries;
- one observable Host boundary for auth, cancellation, limits, and errors;
- no per-Skill session-file races;
- restart/idempotency behavior can be tested independently of DSH models;
- browser and Agent share the same source/revision contracts.

### Costs

- the Host needs a child-process supervisor, request table, queue, timeouts, and generation recovery;
- Python handling must become asynchronous/cooperative for useful cancellation;
- heavy native libraries can still leak or crash the generation and need resource monitoring;
- Windows process termination/path behavior requires explicit tests before platform claims.

## Rejected alternatives

1. **One subprocess per tool call.** Rejected because it defeats persistent indexing and reliable cancellation/recovery.
2. **Python HTTP server exposed to the browser.** Rejected because it creates a second auth/server boundary.
3. **One process per document.** Rejected for the first release due to resource explosion and lifecycle complexity.
4. **In-process Python embedding in Node.** Rejected because native/runtime coupling weakens isolation and packaging.
5. **Retry every missing response.** Rejected because ingest/render may have committed cache state before interruption.

## Required M1 verification

- start/health/capabilities/ready and incompatible-version refusal;
- startup timeout, malformed line, unknown/duplicate ID, stderr flood, early exit, crash/backoff;
- queue limit and concurrency fairness across Sessions/documents;
- AbortSignal → sidecar cancellation and late-result rejection;
- graceful disposal and forced termination;
- read retry vs ingest idempotency after restart;
- atomic cache publication under crash injection;
- path containment and absence of model credentials;
- packaged plugin + wheel smoke on the pinned DSH runtime target.
