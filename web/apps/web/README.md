# DocAtlas Web — Prototype 01

ADR-037 connects live PDF text selections to server-verified one-shot tickets and a multi-selection question tray. Staging
response loss retains its key for explicit retry; reload restores tickets without auto-sending. Sending freezes exact IDs,
and receipt acknowledgement removes them from the next question. The verified selection can reopen the same original
page; no automatic Note/Evidence or verified answer citation is created. Table/image regions, pinning and full Compare
remain pending. Earlier ADR-034/036 limitations below describe their respective implementation stages.

An independent `live.html` entry uses paired product authentication, real submissions/receipts, checkpoint-backed
snapshots and SSE. It never imports simulated answers. Drafts/uncertain submission keys stay in tab-scoped sessionStorage;
auth secrets do not. `index.html` and its fixture-driven PDF interaction remain unchanged. The live entry is not a default
deployed application: conversation/runtime setup, uploads, complete history/controls and actual evidence reading are still
pending at ADR-034; ADR-035/036 now add managed conversation creation and PDF admission below. `bash scripts/pnpmw run test:live` builds the real client and tests it with an isolated Pi worker and explicit faux
model over ephemeral loopback HTTP (including strict CSP and desktop/mobile accessibility). See ADR-034.

The live page also creates conversations through the managed server port. An uncertain creation uses the same tab-scoped
key when retried. RuntimeManager supports verified clean reopen of native history; the page does not pretend an unclean
shutdown is recovered, and does not accept paths, approvals or provider configuration from browser forms (ADR-035).

Live「资料」uploads to the paired service, shows processing/failed states, selects committed exact revisions for questions,
and opens the same hash-verified original PDF beside chat (mobile switches to the reader). It reuses the PDF.js renderer
through demo-independent source types. Selected sources and uncertain upload metadata are tab-scoped; binary PDF data is
not written to sessionStorage. Structured citation/selection tickets and full retention/version/Library UX remain pending.
The strict browser harness permits self-hosted PDF worker/Wasm (`wasm-unsafe-eval`, not JavaScript `unsafe-eval`) and keeps
all assets self-hosted; arbitrary script/eval is not enabled. See ADR-036.

Status: runnable interaction prototype, not the production Pi Web application.

Default centered chat → conversation → optional original-PDF/working surface beside the same chat. Citations focus only
verified original-PDF geometry. Proactive reading, multi-document organization, selection Ask, Compare, Notebook,
Claim/Review/Publish, Continuity, Personalization and native code/terminal/artifact work remain reachable.

The prototype entry implements centered chat, scripted sample answers, real PDF.js rendering and exact-quote geometry,
selection questions, temporary notes, browser-local PDFs and temporary presentation choices. No model, Pi runtime,
DSH, Python sidecar or domain database is connected to that prototype. Refresh clears demo state. Production shared reader extraction into
`packages/reader` remains a later migration, not a claim about this prototype's transient types.

The visual refinement adds a neutral paper/ink/blue palette, more readable type, accessible citation previews,
a draggable/keyboard-operated reader split, and expandable one-shot selection cards. Clicks still navigate directly
to the original PDF. Resizing does not discard drafts or steal keyboard focus; layout is not a learned preference.

From the workspace root:

```bash
bash scripts/pnpmw run demo
bash scripts/pnpmw run test:demo
```

Use the authenticated localhost:4175 URL printed by the launcher; forward that port when working remotely. The preview
serves only built public/example assets. Private PDFs are browser-local, not uploaded or served from the workspace.
See [the prototype guide](../../docs/product/prototype-01.md) and [third-party notices](THIRD_PARTY_NOTICES.md).

[Product specification](../../docs/product/web-experience.md) · [Acceptance queue](../../docs/execution-tracker.md)
