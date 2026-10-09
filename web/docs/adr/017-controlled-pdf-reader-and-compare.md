# ADR-017: The PDF reader is controlled, revision-bound, and comparison cursors are independent

- Status: Accepted
- Date: 2026-08-31
- Owners: DocAtlas maintainers

## Context

A native browser PDF object can display source bytes, but it cannot reliably expose the selected paragraph, bind a
selection to DocAtlas block identity, or accept a verified citation focus. Page-number navigation alone is also unsafe
in a multi-document comparison: page 12 in document A has no implied relationship to page 12 in document B. The
current extractor supplies page text and stable blocks but no trustworthy PDF coordinates, so a visual overlay would
create false precision.

## Decision

1. The public Agent surface remains exactly `docatlas_search` plus one `docatlas_read` tool with the five modes
   `locate/blocks/expand/sequential/visual`. A sixth sidecar mode, `page`, is an internal Reader primitive and is never
   advertised in the model tool schema.
2. Sidecar protocol 1.2.0 / document RPC 1.1.0 adds bounded `page` reads. They verify that the physical page exists,
   return blocks ordered by `page_block_index`, and use a representation-and-page-bound cursor when item or character
   limits truncate the result.
3. Authenticated `reader/page` accepts only Session, Workspace, document, revision, physical page, pixel budget, and an
   optional opaque cursor. The Host rechecks live Workspace membership and the Library's exact non-archived current
   revision/active representation before issuing sidecar `page` and `visual` calls. Requests and responses contain no
   path or server URL.
4. The Client derives the page-image URL from the returned opaque asset ID and the existing authenticated asset route.
   Library authorization for a derived page image requires its descriptor to match the current document revision,
   active representation hash, and physical-page bounds.
5. A PDF page presents the immutable PDFium bitmap beside a selectable HTML text rail. Every displayed block carries
   its exact Locator identity. Empty, sparse, garbled, and truncated extraction states remain visible. The original PDF
   is a fallback link, not the primary interaction surface.
6. Citation focus highlights text only when the resolved Locator matches the displayed document, revision,
   representation hash, page, and one block with a unique exact quote. The page bitmap receives no bbox overlay until
   a provider supplies real coordinates.
7. Compare opens two exact current-revision readers. Each owns its own document identity and page cursor; no movement is
   synchronized by bare page number. Wide layouts use two panes. Narrow layouts use an accessible A/B tab switch over
   the same state model.
8. Text selections are captured only from the primary controlled text surface and retain the physical page at selection
   time. Submission still uses the existing SelectionContext and the single DSH Agent Loop. Changing which Library
   document is primary is the explicit way to select from the other comparison source.

## Consequences

- Users can inspect page pixels and select exact extracted text without sending whole-page text to the Agent.
- Scanned pages remain readable as images while honestly reporting that exact text selection/OCR is unavailable.
- Compare is a reading/navigation feature, not evidence alignment: equal page numbers, nearby text, and visual geometry
  never create a cross-document relationship.
- Future bbox/OCR providers can enrich the same Locator and Reader contracts without replacing the DSH Agent Loop.
- The protocol minor versions intentionally changed because old sidecars cannot serve the internal page primitive.

## Required verification

- schema/type parity, page cursor continuation, empty-page behavior, and public tool exclusion of `page`;
- wrong Session, Workspace, document, revision, representation, hash, page, or sidecar result fails closed;
- page-image fetch is authorized only for the exact current Library identity;
- citation focus never highlights a different document or page;
- desktop side-by-side and narrow A/B comparison preserve independent cursors;
- keyboard navigation, named landmarks/controls, 44px controls, reduced-motion behavior, and automated accessibility
  checks pass in Chromium;
- deterministic ten-class PDF fixtures and a separate local real-PDF corpus smoke cover renderable, empty, encrypted,
  malformed, rotated, multi-page, table/figure, and same-page-number cases.
