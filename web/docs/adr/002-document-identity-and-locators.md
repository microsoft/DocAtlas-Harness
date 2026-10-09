# ADR-002: Document identity and locators

> Status: Accepted
> Date: 2026-08-30
> Owners: Source World and Evidence contracts

## Context

Legacy DocAtlas Notes identify evidence with free text such as `Page 2`. In a multi-document tree every document starts
at physical page 1, so page-only enrichment can write a finding into the wrong document. Page numbers also cannot
survive revisions, distinguish PDF text from OCR/Markdown, locate a table cell or figure, or prove that the quoted text
still matches the source.

A browser citation requires more than a label: it must select the correct immutable source state, locate the intended
segment through complementary selectors, expose ambiguity/staleness, and support permission checks before content is
revealed.

## Decision

### Separate five identities

```text
Logical Document   stable user/provider concept, e.g. "2026 annual report"
Document Revision  immutable bytes/version of that document
Representation     original or derived view of one revision
Document Locator   immutable target within one representation/revision
Evidence Atom      bounded content assertion captured through one locator
```

No filesystem path, display name, document ordinal, bare page number, or tree node ID is a substitute for these IDs.
IDs are opaque. Content hashes are stored separately and used for integrity/deduplication, not exposed as paths.

### Logical document and revision

- `documentId` groups revisions that a user/provider has explicitly identified as one logical document.
- `revisionId` identifies one immutable source revision. New bytes create a new revision; they never overwrite an old
  citation target.
- `contentHash` and `byteLength` identify the bytes for integrity and deduplication.
- identical bytes can share blob storage while retaining separate logical-document permission/context records.
- a source scope pins explicit revision IDs. “Current revision” is a query result, not a mutable citation pointer.
- deleted/quarantined/superseded revisions retain lifecycle status and impact references according to policy.

### Representation

Each revision can have original bytes, page images, embedded text, OCR text, derived Markdown, table extraction,
figure crops, or model descriptions. A derived representation records:

- its own immutable `representationId` and content hash;
- kind/media type/text quality;
- generator name/version/config hash;
- parent representation IDs;
- lifecycle status.

Model descriptions and OCR are not source quotes. The UI must permit returning to original page pixels.

### Locator

A locator always contains:

```text
documentId + revisionId + representationId + 1-based physicalPage
+ representationContentHash
+ one or more complementary selectors
```

Supported selector families in M0 are:

- deterministic block ID;
- TextQuote with exact/prefix/suffix/normalized hash;
- TextPosition with explicitly defined Unicode-scalar indexing;
- ratio or PDF-point bounding box with rotation;
- table ID and optional row/column;
- figure ID.

Multiple selectors are intended to locate the same segment and must be cross-checked. Source state/revision is resolved
before any selector. Printed page labels are presentation metadata; all wire page indexes are physical, one-based PDF
pages.

Locators are immutable. Re-anchoring creates a new locator with `supersedesLocatorId`; it does not rewrite an old
Artifact or Note silently. A tree node ID may be cached as a projection hint but is not locator identity because a tree
can be regenerated.

### Resolution states

Resolver results distinguish:

```text
resolved       selectors agree on an exact target
page-only      revision/page exists but the exact segment cannot be confirmed
ambiguous      valid selectors disagree or multiple candidates remain
stale          target belongs to an older/changed representation
missing        source/representation/target no longer resolves
denied         caller lacks permission; no content leaks
```

Failure does not silently choose a similar paragraph. The UI may offer candidates or re-anchor, but factual use remains
blocked according to the current Review mode/policy.

### Evidence Atom

An Evidence Atom is immutable bounded content tied to a locator and repeats document/revision/representation IDs for
querying and integrity checks. It records content hash, kind, source role, actor/provenance activity, creation time,
lifecycle status, and resolution status.

Cross-object validators require the Evidence and Locator identities to match. A model-derived source cannot be used to
independently support its ancestor Claim.

### Source scope

Every investigation answer/tool operation uses a versioned source scope containing explicit document+revision entries
and source roles. A revision cannot appear in both included and excluded lists. Historical recall may suggest a source,
but adding it creates a new `SourceScopeVersion` through policy or a user command.

## Consequences

### Positive

- fixes multi-document same-page ambiguity by construction;
- citations can jump to exact source context and report stale/ambiguous states;
- PDF, OCR, Markdown, table, and figure evidence preserve their authority differences;
- revision impact and selective revalidation become possible;
- source permissions can be checked before resolving content;
- Tree Overlay can be rebuilt from locator-bound objects.

### Costs

- ingestion must create and persist stable revision/representation metadata;
- selectors need normalized text maps and coordinate transforms;
- re-anchor and migration become explicit workflows;
- duplicate identifiers across Evidence/Locator are intentionally checked for integrity;
- old `Page N` Notes can only import as unresolved/unverified until manually anchored.

## Rejected alternatives

1. **`filename + page`.** Display names change, collide, and are not permission/revision identities.
2. **One global page offset for merged documents.** It breaks source-native page references and is fragile to reorder.
3. **Only bbox.** Coordinates drift across revisions/representations and do not prove text content.
4. **Only exact quote.** Repeated text is ambiguous and tables/figures need spatial identity.
5. **Mutate locators after source updates.** It makes old published artifacts unreproducible.
6. **Tree node ID as citation.** Trees are derived and can be rebuilt with different nodes.

## Required semantic validation

JSON Schema validates shape; bindings additionally enforce:

- text position `start < end`;
- ratio bbox `x + width <= 1` and `y + height <= 1`;
- no duplicate source revision in included/excluded scope entries;
- Evidence identity equals its referenced Locator identity;
- `supersedesLocatorId != locatorId`;
- derived representation lineage is acyclic at persistence time;
- multiple current revisions/representations obey store-level uniqueness policy.

## Verification

- two documents with physical page 2 always resolve to different locator/evidence IDs;
- stale revision, conflicting quote/bbox, rotated page, table cell, figure, OCR and page-only fixtures;
- cross-language schema and semantic-validation parity;
- browser citation focus never resolves a raw path from Client input;
- legacy Note importer cannot create resolved Evidence from a page string alone;
- property tests cover selector boundaries, Unicode indexing and malformed IDs/hashes.
