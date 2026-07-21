---
name: Read
description: Read pages from a document. Returns MinerU markdown (preferred) or PyPDF text, with optional page screenshots and sub-image fetching. When markdown is available, a figure_images_meta catalog is included — use the figures parameter to fetch specific sub-image pixels. Triggers include "read page 5", "what does page 12 say", "show me the chart on page 3", "extract pages 3-5".
---

# Read — the single content-retrieval tool

Read fetches text, page screenshots, and sub-image pixels for specific pages
of a PDF. It is the **only** tool for bringing document content into the
conversation — text extraction, page screenshots, and figure sub-images are
all handled here.

## When to use

* After **Search** identifies candidate pages — pass them directly to Read.
* When you need the actual text of specific pages.
* When you need a page rendered as an image (`with_image`) for figures,
  charts, tables, or scanned content.
* When `figure_images_meta` from a previous Read call lists a sub-image you
  want to inspect — call Read again with `figures` to fetch it.

## When NOT to use

* You don't know which pages are relevant yet — call **Search** first.
* Don't read more than **5 pages per call**. If Search returned more, read
  the top 5 first; read remaining candidates in follow-up calls.
* The document is a non-PDF format — Read only supports PDFs.

## Text retrieval

Read returns text in one of two modes:

* **markdown** (preferred): When MinerU per-page markdown is available, you
  get structured headings, tables, and inline figure references. Each page
  also includes a `figure_images_meta` catalog listing available sub-images
  with their dimensions and byte sizes.
* **text** (fallback): Raw PyPDF extraction when markdown is unavailable.

If `text_is_empty: true`, the PDF is scanned/image-only. Re-run with
`with_image: true` for vision-based reading.

## Page screenshots (`with_image`)

Set `with_image: true` when:
* The page contains charts, diagrams, or complex tables where layout matters.
* Text extraction returned empty or garbled content.
* You need visual context to interpret the page.

Use `zoom` (default 1.0) to control screenshot resolution — higher values
produce larger images and consume more tokens.

## Sub-image workflow

When Read returns markdown mode, each page may include a `figure_images_meta`
catalog listing sub-images (charts, figures, diagrams) extracted by MinerU.
To fetch a specific sub-image:

1. **Read pages**: `Read(pages="3")` — inspect the `figure_images_meta` catalog.
2. **Fetch figures**: `Read(pages="3", figures=[{"page": 3, "ref": "image_1"}])`
   — the response includes base64 pixels for the requested sub-image.
3. If a figure is too small and was filtered out, use `force_figures: true`
   to bypass the minimum-size filter.

Addressing is by `(page, ref)` where `ref` matches `image_N` from the
catalog. Invalid refs return an error with `available_refs` for
self-correction.

## Parameters

| Parameter | Type | Default | Description |
|---|---|---|---|
| `pages` | string | *(required)* | Page numbers, e.g. `"1,3-5,8"`. ≤5 pages recommended. |
| `with_image` | boolean | false | Attach full-page screenshots (PNG). |
| `figures` | array | [] | Sub-images to fetch: `[{"page": N, "ref": "image_N"}]`. |
| `force_figures` | boolean | false | Bypass minimum-size filter for figures. |
| `zoom` | number | 1.0 | Zoom factor for page screenshots. |
| `doc_id` | string | null | Document identifier override. |

**Visual Question Routing (selective)**:
When the question EXPLICITLY asks about visual content (e.g. "what does the chart show", "in figure X", "in the diagram", "according to the plot/graph"), prefer with_image=true on Read calls. For text/numeric questions where 'table' or 'chart' merely describes the source location, with_image=true is optional.

## Best practices

* **≤5 pages per call.** Narrower reads keep context focused. Read the most
  relevant pages first; if the answer isn't found, read remaining candidates.
* **Search first.** Don't guess page numbers — let Search find them.
* **Note after reading.** Once you find an answer or key information, write
  it down with **Note** so later turns don't need to re-read.
* **Prefer markdown mode.** When available, markdown gives you structured
  tables and headings that are easier to parse than raw text.
* **Use sub-images selectively.** Don't fetch every figure — only those
  relevant to the question. Check the catalog metadata first.

## Recommended workflow

```
Search("quarterly revenue 2018")
  → pages [12, 47, 48]

Read(pages="12,47-48")
  → text + figure_images_meta with image_1 on page 47

Read(pages="47", figures=[{"page": 47, "ref": "image_1"}])
  → sub-image pixels for the revenue chart

Note(text="Revenue was $32.8B in 2018, per table on p.47", evidence=[47])
```

## Failure modes

* `error: PDF not found` — bad path; check working directory.
* `missing_pages` non-empty — out-of-range pages; the rest still succeeded.
* `text_is_empty: true` — scanned PDF. Re-run with `with_image: true`.
* `errors[].reason == "ref_not_found"` — bad figure ref; check `available_refs`.
