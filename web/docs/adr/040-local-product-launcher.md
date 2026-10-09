# ADR-040: Supported loopback Pi product beta

> Status: Local beta implementation/verification; not a public production deployment
> Date: 2026-09-09

The accepted prototype now has a real product entry instead of requiring an internal browser-test server. The launcher
composes the existing ControlStore, RuntimeCatalog/Manager, DocumentApplication, UploadStore, paired HTTP/SSE and built
live Web client. It starts no alternative Agent Loop and does not import the faux model/test harness. The DSH launcher
and labeled simulation prototype remain independent.

Default listener is `127.0.0.1:4177`; there is no `0.0.0.0` or reverse-proxy-trust shortcut. The operator uses the same
localhost port through SSH forwarding. A short-lived one-use pairing code is shown locally, never embedded in HTML or
placed in a URL. Anonymous static content is only an in-memory allowlist of built live assets; all user data/API operations
remain authenticated with the existing exact Host/Origin/CSRF checks. Asset routes never resolve browser filesystem paths.

The dedicated state root has separate `workspace` (native tool RW), `private` (product/domain/receipts), `runtime` (Pi
sessions), `document-cache`, `uploads`, `resources`, and `trusted-resources` directories. No sibling checkout is mutated,
no existing user data is migrated or deleted, and the product root is ignored by Git. An initial empty conversation is
created idempotently; no model request runs until the user submits. Normal shutdown waits for actual runtime/document
joins and native seals; unclean catalog claims still require inspection, never automatic PID/TTL takeover.

An empty trusted-resource snapshot is approved as empty. Nonempty resources require the exact operator-reviewed snapshot
hash on startup; changed files require new review. Original mutable resources and product secrets are never mounted into
Pi. Native Pi tools remain available in the dedicated workspace and optional trusted resources remain supported; this
beta does not claim all branch/history/extension UI/provider administration is already exposed in Web.

The configured model is exactly `gpt-5.6-luna` at the user's Azure resource, through Pi ModelRuntime's public Responses
provider. Azure Entra tokens are obtained in the host only, kept in memory, omitted from argv/logs/native messages/browser
catalogs, and renewed through Azure CLI per request. No Python credentials, default auth-file scan or fallback model is
introduced. Cancellation includes the actual token-helper process. Only the allowlisted HTTPS Responses target receives
the token; redirects and endpoint overrides are denied, provider errors are sanitized, and `store:false` remains forced.

Official sources actually read on 2026-09-09:

- [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna): text/image input, streaming/function calling,
  1,050,000 context, 128,000 output, and none/low/medium/high/xhigh/max reasoning. Pi `minimal` maps to `low`; `off` to `none`.
- [Responses migration](https://developers.openai.com/api/docs/guides/responses-vs-chat-completions): Responses is recommended
  for new integrations; explicit `store:false` disables hosted response storage. The Pi loop still owns conversation state.
- [Function calling](https://developers.openai.com/api/docs/guides/function-calling): omitted `strict` on Responses can
  normalize optional properties into required ones. Pi's existing optional tool parameters therefore need explicit
  `strict:false` on this transport. The Azure model declares `compat.supportsStrictMode:true` so the pinned Pi adapter
  emits that field; Core's mode-specific validation and native tool definitions are not weakened or replaced.

OpenAI list prices are reference metadata, not confirmation of this Azure subscription's rates or entitlement. Official
model documentation cannot prove this Azure deployment is accessible; the opt-in network smoke must establish that.

First-launch acceptance covers real authenticated local service, model transport, PDF admission/citations/selection and
clean restart. Corpus-level accuracy/latency, unusual PDF geometry/OCR, abrupt-host-death recovery, shared users/public TLS,
all native controls, long-term research/Memory/personalization, migration/backup/retention remain explicit plan gates.
