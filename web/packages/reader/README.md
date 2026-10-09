# DocAtlas Reader — ownership scaffold

Status: planned extraction; current reader remains in `plugins/docatlas-dsh/src/client/EvidenceDeskView.tsx`.

`apps/web/src/PdfReader.tsx` is a separate D0 PDF.js interaction prototype. It has not yet been promoted into this
production package or its formal Locator/transport contracts; see ADR-022.

Own shared source focus/return stack, user versus Agent cursor, verified geometry, selection models and source/Compare
presentation. Depend on contracts and explicit asset/command interfaces, not DSH chat/workspace snapshots or Pi state.
Do not simply relocate the coupled view and call it a reusable Reader. Preserve original-PDF, no-fake-highlight and
atomic selection tests while splitting state and UI.

[Web behavior](../../docs/product/web-experience.md) · [Migration inputs](../../docs/migration/dsh-to-core.md)
