# DocAtlas Web UI

Read long PDFs, ask grounded questions, and follow citations back to the
original page. This optional local application sits alongside the
[DocAtlas Python CLI/TUI](../README.md), with its own TypeScript Core,
embedded Pi runtime, and Python document sidecar. Installing Web does not
replace the CLI environment or its benchmark workflow.

> **Paper reproduction requires MinerU 2.5.** Use the original Python
> evaluation workflow with MinerU's per-page Markdown and extracted figures;
> see the [reproduction requirements](../README.md#paper-reproduction-mineru-25-required).
> Web's PDF/Flash pipeline and the CLI's Docling convenience backend are not
> substitutes for that preprocessing. Web UI demos do not reproduce paper scores.

![DocAtlas Web UI walkthrough with the DocAtlas paper: upload, ask, verify the original, and explore the document map](assets/web-ui.gif)

*DocAtlas reading its own paper. Re-edited promotional-demo footage with
macOS-style framing, recorded on Linux. Waiting periods and reading holds
are edited; this is not a speed benchmark or a claim of macOS support.
[Media notes](docs/review/readme-media.md) · [Still image](assets/web-ui.png).*

## Quick start

### Requirements

- **Linux** with bubblewrap, libseccomp, and working unprivileged user/PID
  namespaces. Document and native-tool isolation is required; there is no
  unsandboxed fallback.
- **Node 22.19.0 and pnpm 11.7.0**, through `scripts/pnpmw`. The wrapper
  selects the pinned Node version, downloading it locally when needed.
- **CPython 3.12.12 and uv 0.9.21** for the independent document sidecar.
- **Azure CLI and authorized access to the configured GPT-5.6 Luna
  deployment.** An Azure login alone does not grant access to that deployment.

From the repository root:

```sh
cd web
bash scripts/pnpmw install --frozen-lockfile
env -u VIRTUAL_ENV uv sync --locked --all-packages --all-groups
az login
bash scripts/run-docatlas-web.sh
```

Open **http://127.0.0.1:4177/**. The local browser entry needs no account,
login, or pairing code. After setup, you can also launch it from the
repository root with `bash scripts/run-docatlas-web.sh`.

This is a **single-user, loopback-only beta**. Anyone who can access its local
port can use the workspace. Do not expose it to the Internet or a shared proxy.
For a remote development machine, use a private SSH tunnel with matching local
and remote ports, and open `127.0.0.1` in the browser. Host/Origin, CSRF, source
permissions, and native-tool authorization remain enforced.

### Model access

The launcher currently uses the reviewed GPT-5.6 Luna host provider; it is not
a generic public-provider launcher. Root CLI `.env`/API-key settings do not
configure Web, and Web has no fake-model fallback. Short-lived Azure tokens
stay in the host broker, outside the browser, worker, and Pi transcript;
Azure CLI retains its own existing login cache.

PDF processing and durable state are local. Questions and tool-returned
document content are sent to the configured model service. See the
[local beta guide](docs/product/local-web-beta.md) for provider and trusted
resource details.

## Your first document

1. **Upload a PDF** and wait for “Document ready.” Use Library to select
   existing documents; the attached file chips show the next question's scope.
2. **Ask a question.** The selected document revisions are frozen when you
   send; opening another PDF does not silently change that question's sources.
3. **Check the original.** Click a citation to open the same PDF revision.
   A unique verified text match is highlighted; otherwise the reader explicitly
   reports page-only or ambiguous positioning.
4. **Follow up on a passage.** Select PDF text and choose Ask to attach it to
   your draft. The question is sent only when you explicitly submit it.
5. **Keep research separately.** Use Research notes or Findings and review
   when needed. Saving a note does not send a question or turn note prose into
   source evidence.

The reader also offers a document outline and Map. Native Pi tools, history,
runtime controls, research continuity, and consent-based personalization remain
available through their respective controls. Detailed workflows and remaining
acceptance gates are in the [local beta guide](docs/product/local-web-beta.md)
and [execution tracker](docs/execution-tracker.md).

## Optional tree search

In **More actions → Document search**, choose the strategy for your question:

| Strategy | Behavior |
|---|---|
| Default / Keyword only | Lexical search; the default behavior. |
| Document tree | Navigate existing Flash tree nodes and their page ranges. |
| Tree + keyword | Combine structural navigation with lexical candidates. |

Tree search supports up to **16 selected source revisions**. It may reuse
completed same-generation summary excerpts, but never starts a summary job
implicitly. Larger source selections can use keyword search; unavailable or
truncated results are reported explicitly.

Trees, summaries, and recalled notes are navigation aids, not evidence.
Factual answer citations require actual Read results tied to the verified
native checkpoint. Search mode is preserved in the submitted request and its
pending retry, not inferred from whichever PDF is open.

## Local state and shutdown

- The default state directory is `web/.cache/product/` relative to the
  repository root, separate from CLI sessions and the simulated prototype.
- Stop with **Ctrl+C** and let shutdown finish before restarting. A clean
  restart reopens the same native session; an unverified crash is not
  automatically treated as safely recovered.
- Use `--state-root /absolute/dedicated/path` for a separate workspace and
  `--port 4178` for a different loopback port. The absolute state root is part
  of actor/workspace identity; it is not a casual relocation setting.
- Keep one writer per state directory. Do not copy CLI `session.json` into it,
  delete claims to bypass recovery checks, or treat one SQLite file as a full
  backup. Reusing existing Web data requires a separate clean-stop, backup,
  and compatibility review.
- Adding trusted Skills/extensions requires review of the exact resource
  snapshot and `--resource-hash <reviewed-sha256>`; do not approve arbitrary
  uploaded document content as executable resources.

## Development and verification

Run these commands from `web/`, after the frozen installs above:

```sh
bash scripts/prepare-test-source.sh
bash scripts/check.sh
bash scripts/pnpmw exec playwright install chromium
bash scripts/pnpmw run test:live
```

The check builds the dependency graph before type checks and tests, then checks
Python lint/types, coverage, Pi patch integrity, Flash provenance, and the
packaged sidecar. The pinned PageIndex checkout is used only for source/patch
verification, not at runtime. Do not rebuild shared outputs while browser tests
are running.

On shared development hosts with large unrelated mount tables, use
`bash scripts/pnpmw run check:clean-host` and
`bash scripts/pnpmw run test:live:clean-host`. They run the same checks in a
minimal verification mount namespace; assertions, deadlines, and real nested
isolation stay enabled. After a build,
`bash scripts/pnpmw run test:coverage:clean-host` produces the JS coverage report
under `.cache/coverage/js/`; Python reports live in `.cache/coverage/python/`.

Browser tests use real isolated Pi/PDF paths and an explicit scripted model.
Real-provider smoke tests are separate, opt-in network tests, not part of CI.
Passing these tests does not establish real-model quality or reproduce the
paper's scores, original CLI output, or performance.

`apps/web/live.html` is the real client served by the product launcher.
`apps/web/index.html` is the separately labeled simulated prototype, not a
fallback for real answers. See the [frontend guide](apps/web/README.md) for
entry points and component development.

## Scope and maintenance

Public deployment, arbitrary providers, cross-platform parity, full crash
recovery, and real-corpus/OCR quality remain separate acceptance gates.
Research notes, evidence, review, and personal preferences are distinct domains.
The implementation does not silently promote one into another.

- [Migration design (ADR-064)](docs/adr/064-standalone-web-main.md) and
  [migration queue](docs/migration/main-web.md): scope and acceptance.
- [Migration source](migration-source.json): immutable imported snapshot;
  subsequent maintenance is recorded in this branch's Git history.
- [Code audit](docs/review/grounded-web-code-audit.md) and
  [runtime security maintenance (ADR-065)](docs/adr/065-reviewed-runtime-security-maintenance.md):
  reviewed fixes, coverage, and preserved boundaries.
- [Original CLI security candidate](docs/review/original-cli-security-maintenance.md):
  separate dependency review. Its Docling output/performance differences still
  require explicit acceptance before merging; a Web audit is not that approval.
- [Implementation plan](docs/implementation-plan.md): current delivery status
  and open gates.
