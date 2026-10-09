# DocAtlas Grounded Web

An independent, local Web application beside the original Python CLI/TUI. It
uses the final live reading/research interface with a Pi execution runtime,
progressive document tools and checkpoint-backed original-PDF citations.
The original CLI, benchmark defaults and root Python environment are unchanged.
Web does not claim to reproduce the paper's benchmark scores or CLI performance.

## Local setup

Supported execution environment: Linux with bubblewrap/libseccomp, Node
22.19.0, pnpm 11.7.0, CPython 3.12.12 and uv 0.9.21. Use the pinned wrapper;
the ordinary root Python installation does not install Node or this environment.

```sh
cd web
bash scripts/pnpmw install --frozen-lockfile
env -u VIRTUAL_ENV uv sync --locked --all-packages --all-groups
bash scripts/run-docatlas-web.sh
```

The current host provider is the reviewed GPT-5.6 Luna Azure deployment and
requires an authorized Azure CLI login on the host. Credentials never enter the
browser, worker or native transcript. This is not a generic public-provider
launcher and there is no fake-model fallback. From the repository root, use
`bash scripts/run-docatlas-web.sh` after setup. An optional `--state-root`
selects a dedicated absolute product data directory.

The application binds only to `127.0.0.1:4177`, without browser login or pairing.
Do not expose it to the Internet or a shared proxy. Model configuration remains
host-owned; exact Host/Origin/CSRF and document/native permissions remain active.
`live.html` is real; `index.html` is the separate explicitly simulated prototype,
not a replacement for real answers.

## Reading and research

Upload PDFs, ask questions, inspect the cited original, select a passage for a
follow-up, and save independent research notes. Notes, revisions and review
work remain separate from source Evidence. Tree/summary navigation is not proof;
formal answer citations require the actual verified Read/checkpoint lineage.
The native Pi tools and advanced research/continuity/profile controls are retained.

In **More actions → Document search**, optionally choose keyword-only, document
tree, or tree + keyword for the question. Default search stays lexical. The host
freezes the selection into the submission/outbox and applies it at actual native
consumption. Tree routing validates real Flash nodes and may reuse already
completed same-generation summary excerpts; it never generates new summaries
implicitly. Both candidate kinds still need original Read before factual use.
Tree search is bounded to 16 selected source revisions; larger selections can
use lexical search. Truncation/unavailability is explicit, not a fake fallback.

New local state lives under `web/.cache/product`. Do not copy CLI session.json
into it, move existing state casually, or run two writers against one directory.
Actor/workspace identity depends on the absolute state root. Existing Web data
reuse is a separate backup/clean-stop/compatibility operation; this code migration
does not move live data or override unclean claims.

## Verification

```sh
bash scripts/prepare-test-source.sh
bash scripts/check.sh
bash scripts/pnpmw exec playwright install chromium
bash scripts/pnpmw run test:live
```

The pinned PageIndex checkout is for source/patch acceptance only, not a runtime
dependency. The check builds the dependency graph before tests and verifies the
actual sidecar wheel, including Flash provenance/source/license bytes. Browser
fixtures use actual isolated Pi/PDF paths and an explicit faux model; they are
not real-model quality claims. Real-provider smoke tests remain explicit opt-in.

On shared development hosts with thousands of unrelated container mounts, use
`bash scripts/pnpmw run check:clean-host` and
`bash scripts/pnpmw run test:live:clean-host`. These run the same complete checks
inside a minimal verification mount namespace using the shared process guard;
no test assertion, deadline or production isolation is disabled. This affects
only the verification environment, not product performance or user data.

See [ADR-064](docs/adr/064-standalone-web-main.md), the [migration queue](docs/migration/main-web.md),
and `migration-source.json` for source identity, accepted scope and implementation
status. Full public deployment, arbitrary providers, cross-platform parity and
general crash recovery are not implied by this local entry.
