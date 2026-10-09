# ADR-022: Prototype-first delivery before runtime migration

> Status: Accepted
> Date: 2026-09-08
> Basis: user requested an interactive prototype first, followed by functional/UX agreement before concrete product implementation.
> Changes: execution order and prototype boundary; does not replace ADR-021 product ownership.

## Decision

Insert D0 before R1/R2: design and exercise the principal user journeys in a standalone prototype, then agree the first
release interactions and capability scope before resuming large runtime/Core migration. Prior domain plans remain in
scope; the prototype is not a replacement for the product or its contracts.

2026-09-08 follow-up: the user accepted Prototype 01's core functionality and requested visual refinement before starting
backend work. This is evidence for the core journey, not acceptance of all later modules. After the visual handoff, the
next work package can begin R1 contract/security review and the native Pi foundation, followed by the real-document
vertical slice. Later Compare/research/personalization prototypes gate their own modules, not the entire foundation.
No production wire, renderer, security policy or memory behavior is implicitly approved by the visual refinement.

Subsequent user confirmation on 2026-09-08 accepted the current prototype and explicitly requested backend planning
and implementation. The first-journey UX gate is now satisfied. Engineering proposals and the first SDK/lifecycle/
isolation package are recorded in ADR-023 and the backend delivery design; no later module or wire is implicitly accepted.

Prototype 01 is implemented in `apps/web` with React and PDF.js 6.3.289. Real operations include original-PDF rendering,
page navigation, local file selection, source-text selection, quote-based focus, and temporary notes/preferences.
Answers and Agent progress are scripted and visibly labeled. No Pi/model/DSH/sidecar/domain database is connected.

The built-in fixture is the exact original synthetic sample PDF, verified by SHA-256. Citation boxes must be derived
from unique matches in the real PDF text layer, never fabricated. Missing/ambiguous text gets no rectangle. This is a
bounded prototype selector, not the production revision/representation/Locator contract.

Local PDFs stay inside the browser (25 MB/file, four local files). They can be read and selected, but never receive
sample-document answers/citations or a false upload/understanding success. Notes/preferences/drafts reset on refresh;
there is no persistent or automatically learned personal memory.

## Serving and security

The supported preview is a loopback-only, authenticated static server (`scripts/preview-demo.mjs`). It serves a fixed
snapshot of built distributable assets, rejects symlinks/unknown paths, supports bounded byte ranges and GET/HEAD only,
and has no upload/filesystem/RPC endpoint. A process-local access token sets an HttpOnly SameSite cookie and is removed
from the browser address bar. Tokens are not written into repository configuration.

This is not the new production server/auth contract. Product APIs remain gated by R1 review. Vite is a loopback-only
development tool, not an externally exposed service. No model credentials, private source roots, or `.sources` files are
served. Local documents are never sent to the preview server.

## What this prototype does not decide

- full Pi session/stream/persistence integration or native tool permissions;
- production PDF renderer choice, geometry contract, OCR/rotation/cross-page/table guarantees;
- final research memory/personalization behavior, long-term storage or automatic preference promotion;
- complete multi-document Compare/Claim/Review/Publish or general coding-agent workflow implementation.

Those remain in the master plan and get subsequent prototype rounds where useful. A prototype screenshot/test passing
does not satisfy R3/R4/R7 product acceptance. User visual and interaction review remains an explicit gate.
