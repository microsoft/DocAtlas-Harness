# ADR-005: Authenticated source and visual asset transport

> Status: Accepted
> Date: 2026-08-30
> Owners: `docatlas-dsh` Host, Web Client, and Python document sidecar

## Context

PDF readers need byte ranges and visual Read needs page-image bytes. Those payloads are too large for the sidecar JSONL
protocol and must not be copied into DSH Session events. A browser cookie proves that a request belongs to this DSH Web
application; it does not authorize arbitrary filesystem paths or documents outside the investigation source scope.

The sidecar already receives approved root-relative source bindings and owns revision-bound indexes. The Host owns the
authenticated browser boundary and the active source-scope policy. Neither browser URLs nor model tool arguments may
contain server paths.

## Decision

### One authenticated exact Fetch route

The Host registers exact `GET` and `HEAD` route `/api/docatlas.asset` through
`ctx.connection.fetch.register()`. The DSH Connection carrier applies its Host/Origin and signed-cookie checks before
dispatch. The route accepts one opaque `assetId` plus one opaque `sessionId` query parameter and no path parameter.

Every request then passes a DocAtlas authorization check:

1. resolve the opaque ID through the immutable asset descriptor store;
2. resolve exactly the named Session's SourceScope and require the descriptor's exact document + revision in it;
3. reject stale/deleted scope bindings and descriptor/index identity mismatches;
4. open only the descriptor-owned content file below the configured cache root.

Missing `sessionId` is a bad request. The route never guesses a global/sole scope, so two tabs or investigations cannot
borrow each other's asset authorization. Authentication without source authorization returns no asset. Unknown,
malformed, unauthorized, and stale IDs use
minimal non-oracular responses and never reveal a root, relative path, document title, hash, or neighboring asset.

### Immutable cache assets

During ingest, the sidecar copies the verified original revision bytes into an immutable asset entry before publishing
the index. Visual Read renders a page into another immutable entry. Each entry is an atomically renamed directory:

```text
cache/assets/<sha256(assetId)>/
  descriptor.json
  content.bin
```

The canonical descriptor binds `assetId`, kind, document/revision/representation, representation and content hashes,
media type, byte length, optional page/width/height, generator version, and creation time. It never stores an absolute
or root-relative source path. The Host recomputes the descriptor-directory key, validates the descriptor schema, checks
the content file size and SHA-256 before serving, and never follows a descriptor-provided path.

Original-byte asset IDs equal their immutable original representation IDs. Rendered asset IDs are opaque digests of
the revision, representation, page, renderer configuration, and output content. Asset IDs are identities, not bearer
credentials; source-scope authorization is still mandatory.

### HTTP semantics and limits

- Strong ETag is the quoted content SHA-256; matching `If-None-Match` returns 304.
- `Accept-Ranges: bytes` is always present on successful asset metadata.
- At most one canonical byte range is accepted. Open-ended and suffix ranges are supported; malformed, unsatisfiable,
  or multi-range requests return 416 with `Content-Range: bytes */<length>`.
- `If-Range` is honored only for an exact strong ETag; otherwise the full representation is returned.
- `HEAD` returns the same status and headers as `GET` with no body.
- Responses set the descriptor media type, exact `Content-Length`, `X-Content-Type-Options: nosniff`, and
  `private, no-cache, must-revalidate`. Bytes are immutable, but authorization is mutable; strong ETag makes the
  mandatory authorized revalidation inexpensive without letting browser cache bypass scope revocation.
- Source assets remain under the 512 MiB document limit. A rendered image is capped at 40 million pixels and 32 MiB;
  requested scaling is reduced to the pixel ceiling and a render that still exceeds the byte ceiling fails closed.
- Rendering checks physical page bounds and supports full PDF pages first. A `figureId` without a persisted figure crop
  is `unavailable`; it is never silently treated as a page.

### Model and Session surfaces

`docatlas_read(mode="visual")` returns an asset descriptor and Locator in its canonical value. Model-facing content
contains only the asset ID, dimensions, media type, page, and a short instruction; it never repeats page Markdown or
embeds base64. Bounded `tool/result.meta` may retain the Locator and asset ID. Binary bytes stay in the asset store.

## Consequences

### Positive

- browser-native PDF range reads and page images share the existing DSH authentication boundary;
- revision bytes cannot change underneath a citation after ingest;
- path traversal, symlink swaps, and source-root disclosure are removed from the browser protocol;
- deterministic ETags and immutable assets make retries and caching safe;
- tool/session payloads remain bounded and replayable.

### Costs

- ingest duplicates original bytes into the cache and requires asset garbage collection;
- every authorized fetch revalidates content through the same open file handle; safely skipping that pass would require
  an OS-enforced immutable primitive such as fs-verity, not mutable stat timestamps;
- page rendering adds a pinned native PDFium runtime and platform packaging checks;
- the first vertical slice authorizes against the Host's active source-scope snapshot; multi-investigation browser tabs
  require the M2 scope registry to supply the correct snapshot before a fetch.

## Rejected alternatives

1. **Expose source paths in a URL.** Rejected because browser input would become filesystem authority.
2. **Serve directly from Python HTTP.** Rejected because it creates a second authentication/server boundary.
3. **Return base64 through JSON-RPC/tool results.** Rejected for memory, line-size, context, and Session-log costs.
4. **Treat an asset ID as authorization.** Rejected because IDs appear in durable tool results and UI state.
5. **Serve the mutable source file after a one-time hash check.** Rejected because later mutation breaks revision identity.
6. **Support multipart ranges immediately.** Rejected because PDF viewers work with single ranges and multipart parsing
   materially expands the first security boundary.

## Required verification

- unauthenticated and cross-origin requests are rejected by Connection before the plugin handler;
- malformed/unknown/scope-excluded asset IDs do not disclose existence or paths;
- exact, open-ended, suffix, unsatisfiable, multi-range, HEAD, ETag, and If-Range behavior;
- source symlink/mutation after ingest cannot change served bytes;
- crash during copy/render never exposes a partial asset;
- PDF page bounds plus pixel/byte limits, and figure requests fail explicitly;
- visual tool content contains no base64 or duplicate extracted page text;
- package smoke covers the pinned PDFium wheel on the supported runtime platform.
