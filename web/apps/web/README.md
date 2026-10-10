# DocAtlas Web frontend

For installation, model access, and usage, start with the
[Web UI guide](../../README.md). This directory contains the browser client,
not a separate server or Python environment.

## Entry points

| Entry | Purpose |
|---|---|
| `live.html` | Real client: product HTTP/SSE, uploads and Library, saved answers, verified original-PDF citations, selection questions, and research controls. The local product launcher serves this entry at `/`. |
| `index.html` | Explicitly simulated interaction prototype: scripted answers, browser-local PDFs, and temporary demo state. It does not invoke Pi or a model, and is not a fallback for the live client. |

The product launcher uses login-free, single-user loopback access; the generic
paired HTTP interface remains a trusted compatibility interface. Browser forms
cannot choose actor/workspace identity, filesystem paths, or arbitrary model
providers. The live client never imports simulated answers.

The reader renders the original PDF with PDF.js. Clickable answer citations
come from verified Read/checkpoint lineage, not arbitrary model links; ambiguous
text matches do not receive guessed highlights. Research and personalization
use their own authorized product APIs, not prototype state.

## Build and test

From the independent `web/` workspace, after its dependencies are installed:

```sh
bash scripts/pnpmw run check:build
bash scripts/pnpmw --filter @docatlas/web-demo typecheck
```

`check:build` builds the dependency graph in order. For subsequent frontend-only
rebuilds, use `bash scripts/pnpmw run build:demo`. The historical `build:demo` /
`@docatlas/web-demo` names build **both** HTML entries; they do not mean that the
live client is simulated. To run the real application or its browser suite, use
the workspace launcher and checks:

```sh
bash scripts/run-docatlas-web.sh
# Stop the application before rebuilding for verification.
bash scripts/prepare-test-source.sh
bash scripts/check.sh
bash scripts/pnpmw exec playwright install chromium
bash scripts/pnpmw run test:live
```

The full check builds shared packages in dependency order. Browser tests use
ephemeral state, real isolated Pi/PDF execution, and an explicit scripted model;
they are not real-provider quality tests. Do not run a build concurrently with
tests that read the same outputs. Shared-host verification alternatives are
documented in the [Web UI guide](../../README.md#development-and-verification).

## Further reading

- [Local beta workflows and limits](../../docs/product/local-web-beta.md)
- [Product specification](../../docs/product/web-experience.md)
- [Execution tracker](../../docs/execution-tracker.md)
- [Historical prototype design](../../docs/product/prototype-01.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)
