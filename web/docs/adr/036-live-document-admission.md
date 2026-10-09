# ADR-036: Live PDF upload, Library admission and original-byte reading

> Status: Internal implementation; full citation/selection/revision/deployment acceptance remains open
> Date: 2026-09-09

Product authentication authorizes every upload reservation, byte transfer, import intent and read. The server supplies
actor/workspace/conversation context and all paths. Upload metadata and immutable content-addressed bytes are separate
from model workspaces, runtime/catalog state and document caches. Reserve quota durably before receiving bytes; verify
length/hash and fsync before acknowledging storage. Only Library's committed import result makes a revision selectable.

Use the existing Core LibraryService and isolated Python document service, not a second document store/agent loop. Stable
upload candidates survive browser reconnect and do not expose paths. Same bytes may reuse the existing Library revision;
same name with different content does not silently overwrite a document. Explicit replacement/version UI remains work.
An explicit replay of an unfinished import can resume deterministic read/index work, never a model execution.

The live client freezes selected document/revision refs into the existing submission/outbox hash. Exact native consumption
activates DocumentSession; unrelated previews/upload jobs never change an executing prompt's source frame. Pi retains its
native tools alongside DocAtlas Read/Search/Flash navigation. No Python model credentials or second agent loop are added.

Original PDF responses require current Library authorization, exact revision/representation/hash, bounded verified bytes
and reauthorization during output. The existing hash-checked PDF.js rendering is made independent of demo state and may
be reused with an explicit server-backed source label. This is not fabricated citation geometry, native embedded PDF,
or selection/evidence admission: structured answers, verified citations and one-shot selection tickets remain separate.

No default public listener, filesystem discovery endpoint, arbitrary RPC or recovery override is introduced. Tests exercise
real upload bytes, namespaces, Core commits, Pi document calls and Flash; model fixtures remain explicitly synthetic.
