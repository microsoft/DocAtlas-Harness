# ADR-032: Product-owned local pairing and HTTP command boundary

> Status: Internal handler/contract implementation; no default launcher change
> Date: 2026-09-08

Follow backend-delivery's same-origin HTTP + HttpOnly session + Origin/CSRF design. A trusted local application issues a
short-lived, single-use bootstrap code for its configured actor/workspace. The code is exchanged in JSON, never in URLs.
The browser receives a session cookie and CSRF token; bootstrap/session bearer values are retained only as hashes in
bounded memory. The session's CSRF value stays in server memory so an authenticated bootstrap can return it again.
Sessions expire, logout revokes them, and a server restart requires fresh pairing. This is not a new multi-user account
system, an OAuth substitute or permission to persist/print model credentials.

product-http.v1 freezes the small bootstrap/error/cancel envelope. Submit and receipt use existing product-control.v1.
Handlers require exact Host/Origin policy, mutation CSRF, bounded bodies/time, no arbitrary CORS and no-store/CORP headers.
Actor identity comes only from the paired session. Conversation ownership is checked before obtaining its coordinator;
202 means durable acceptance, and stop replies only after runtime quiescence. Unknown outcomes remain unknown.

Initial routes: POST auth exchange/logout, GET bootstrap/receipt, POST submissions/conversation stop. No uploads, arbitrary
paths, RPC method passthrough, approval mutation or model configuration endpoint is implicitly exposed. SSE, snapshots,
Reader/selection/Answer, authenticated UI pairing and complete controls are subsequent contracts; no simulated fallback.
The handler is exercised over real loopback HTTP with the isolated Pi stack, but is not a deployed product or default server.
