# Flash navigation and bounded Han retrieval gate

This is an offline **generated-PDF** gate, not an empirical document corpus or an
LLM answer-quality score. The script creates actual glyph-bearing PDFs, ingests
them through the isolated product PDF worker, builds Flash raw/merge through its
single-worker sandbox, and uses the real Search, Read and original-PDF Locator
resolver. It never supplies mocked text, trees, geometry or model answers.

Batch24's reviewed local adjustment now closes the specific empty-tree cases
below. Historical Batch23 measurements remain intact; current results are in
[the post-patch record](#batch24-reviewed-numbered-heading-adjustment).

## Run

```sh
env -u VIRTUAL_ENV uv run --locked --package docatlas-dsh-sidecar python scripts/evaluate-flash-quality.py
```

Use `--case chinese-bookmarks --case long-bilingual` for the two bookmarked cases.
`--font /absolute/path/font.ttf` selects a local CJK TTF; the report records its
filename and SHA-256. The default is the system Droid Sans Fallback font. The
generator also uses PDFium's standard Helvetica for Latin glyphs. Dependencies
remain locked; no model, network service, extra Python dependency or source
checkout import is used. Temporary PDFs/indexes are removed on exit; no font or
derived PDF asset is redistributed in this repository.

Exit 0 means the **selected cases and measured axes** met their gates. Exit 2
means a measured quality gap and still prints the whole report. Parser/integrity
failures exit nonzero; they are not relabeled as successful empty navigation.

## Cases and measured axes

| Case | Pages | Known structure |
| --- | ---: | --- |
| Chinese with bookmarks | 8 | Four two-page sections, repeated running header |
| Identical Chinese content, no bookmarks | 8 | Same four visible section headings |
| English repeated headers | 16 | Four four-page sections and explicit bookmarks |
| Long bilingual | 80 | Eight ten-page Chinese sections, Latin unique page anchors |

All pages contain real, generated text; the long case is not 80 copies of one
page. The expected section titles/page ranges and per-page anchors come from the
generator. The gate measures title-and-range coverage, counting titles retained
in merge `keyItems`; running-header pollution; independent raw/merge timings;
first/middle/last-page Read, bounded locate and original-PDF bbox resolution;
and Chinese substring Search/locate page recall. A readable-index snapshot must
remain unchanged after navigation generation. These are navigation and literal
retrieval checks, not semantic relevance, citation support or factual truth.

## 2026-09-09 measurements and local fix

Read-only online checks found PageIndex main still
`ae169566b3148792776531d987f543edcad92321`, JS SDK main still
`9925e8a347a9985424f4bb4e95718a75814b9b67`; both research checkouts were clean.
No upstream upgrade or vendor modification was made.

The initial full run reproduced a concrete product defect: the page text
`本期经营现金流保持稳定且现金储备足以覆盖未来投入` was readable, but
Search for `经营现金流` found zero pages. SQLite `unicode61` indexes the continuous
Han sentence as a token, so a word inside it was missed. This was independent of
the Flash navigation tree.

| Case | Initial raw/merge section coverage | Chinese query before → after local fix |
| --- | --- | --- |
| Chinese with bookmarks | 4/4, 4/4 | 0/8 → 8/8 pages |
| Chinese without bookmarks | 0/4, 0/4; explicit empty tree | 0/8 → 8/8 pages |
| English repeated headers | 0/4, 0/4; explicit empty tree | Not a Chinese query case |
| Long bilingual | 8/8, 8/8 | 0/80 → 80/80 pages |

The same PDF hashes were used before/after the query-time fix. The two measured
post-fix bookmarked cases passed; this does **not** close the other two cases'
navigation gaps. Initial raw times were 3.10–4.88 seconds and merge-from-raw
1.63–1.68 seconds; the 80-page ingest took 7.12 seconds in that run. These are
single-host observations, not statistical speedup claims. Latin anchor locate
returned 18 characters compared with 218–609 for the tested full-page Reads.

The final four-case run also verified Chinese **locate** on every expected page
(8/8, 8/8, 80/80), followed by actual Chinese-text-to-original-PDF bbox resolution
on the first and last pages. The 80-page Chinese Search took 0.027900 seconds in
that run. This has no pre-fix timing baseline and is not a speedup claim.

Reproduction identities and local verification records:

- Eight-page bookmarked PDF SHA-256:
  `6dfa906b49ededeed44a261766a902ae7c8f76f7ad5c34fe69a08eb935bd569d`.
- Eighty-page PDF SHA-256:
  `2c98ee30acd8d010607b48d31e9f9f7148e74ddac2aedd17af60ed58bd0a5a98`.
- Final complete report: `/tmp/docatlas-batch23-flash-quality.B7oQ7P`, exit 2,
  four remaining section-coverage gaps (raw/merge for each of the two empty-tree
  cases), empty stderr. This temporary path is a local run record, not a fixture
  required by the script.
- Focused CJK, existing document-service and real-PDF quality tests:
  `/tmp/docatlas-batch23-flash-tests.WWnyRy`, 26 passed in 37.06 seconds. Ruff and
  the changed production module's strict mypy check also passed. The parent
  integration run owns full-workspace checks and packaged-runtime synchronization.

The local fix in `document_service.py` supplements original FTS results with
literal occurrences of query tokens containing Han characters in verified cached
block **text**, not inherited headings. Existing FTS/BM25 results remain first;
fallback candidates are ordered by source/ordinal, deduplicated by block ID and
use the existing pagination/Locator contracts. Mixed queries retain the existing
OR semantics; this is not Chinese segmentation or semantic retrieval.

The additional scan has one request-wide allowance across all selected sources:
8,192 blocks, 2,000,000 case-folded characters and 16,000,000 character×token work
units. It reads rows incrementally, retains bounded candidates and finishes the
scan before publishing a page. Exceeding any bound returns the existing
`limit-exceeded` error with a request to narrow the scope or read pages, never an
apparently complete partial result. ASCII queries do not enter this scan. No FTS
schema, index generation, canonical tree, wire version or durable store changes.

## Read-only diagnosis of the two empty-tree cases

The same-hash PDFs were traced inside the isolated worker with the supported
settings unchanged: `workers=1`, `useEmbeddedToc=True`, `maxPages=1000`, 2 GiB
address space and 60 CPU seconds. Both passed the early empty/unsupported-script
gate. Their four section headings were correctly extracted as independent 18pt
blocks against 12pt body text; header/footer classification left them eligible.
Thus these are not missing glyphs, missing visual headings or resource failures.

The [pinned extraction pipeline](../../python/docatlas-sidecar/src/docatlas_dsh_sidecar/_vendor/pageindex_flash/flash/main.py)
selects the first chapter as the document title (`detect_title`, line 213).
Its title-echo filter at lines 235–238 then excludes the remaining chapter
headings: they differ only in numbering and fall below the 20% edit-distance
threshold. All four become type 3 before heading collection, which returns empty.
The fixture's lack of a distinct document title and highly repetitive chapter
names trigger this specific heuristic; “repeated running headers cause an empty
tree” or “Chinese headings are unsupported” would be incorrect conclusions.

English also loses its bookmark fallback. The
[bookmark classifier](../../python/docatlas-sidecar/src/docatlas_dsh_sidecar/_vendor/pageindex_flash/flash/embedded_toc.py)
at lines 194–197 maps all four valid `Chapter N: Operating analysis and risk
review` entries to `chapter#operatinganalysisandriskreview` and treats that as a
filing enumeration, not the permitted pure `chapter` numbering template.

| Temporary single-variable control | Actual result |
| --- | --- |
| Chinese: change only the four chapter subtitles to distinct topics | Three detected sections on pages 3/5/7; the first chapter is still consumed as the document title |
| English: shorten only bookmark labels to `Chapter 1/2/3/4`, retaining PDF body/layout | Four hybrid nodes spanning the 16 pages |

These controls did not change the checked-in corpus or its expected results.
The [merge worker](../../python/docatlas-sidecar/src/docatlas_dsh_sidecar/flash_worker.py)
only optimizes nonempty structure (line 98); empty merge is downstream of empty
raw, not a second independent merge defect. No provider/vendor file was changed.

At this diagnosis stage, the next small gate was a 2×2 pair set: distinct document cover/title present or
absent × repeated or distinct chapter names, plus legitimate chapter bookmarks
versus real page/file-number enumerations. Only then review numbered-heading
protection or a source-supported bookmark exception through the approved vendor
generation/upstream-patch process. Preserve the original negative cases; these
observations do not establish general document-corpus quality or justify guessed
headings. The pre-patch complete gate exited 2; the reviewed follow-up is below.

## Batch24 reviewed numbered-heading adjustment

[ADR-051](../../docs/adr/051-flash-numbered-heading-guards.md) and the
[reviewed patch sources](../../compat/pageindex-flash/README.md) implement only a
source-backed numbered-heading/title guard and a narrowly verified bookmark
exception. Root generated the shared vendor once; no hand edits or upstream
checkout changes occurred. The [paired evaluation](../../scripts/evaluate-flash-heading-pairs.py)
locks the four 2×2 PDF hashes to their [actual baseline](heading-pairs-baseline.json).

| Independent cover | Repeated subjects, before → after | Distinct subjects, before → after |
| --- | --- | --- |
| Absent | 0/4 → 4/4 | 3/4 → 4/4 |
| Present | 4/4 → 4/4 | 4/4 → 4/4 |

All 11 real generated-PDF cases passed: the four pairs, supported repeated-topic
Chapter bookmarks, printed page/file counters, unprinted topics, reversed and
duplicate targets, and neighbouring-page-only title support. Every returned node
title was checked through actual Read against its exact physical source page,
with the expected chapter page ranges. Only the supported bookmark case gained
`hybrid` admission; all six negative bookmark cases remained `detected`, retaining
only the genuine detected chapter structure. No source text or heading was invented.

The original four-case corpus was not edited. It now also exits 0: both previous
empty cases produce 4/4 raw and merge sections, the other cases remain 4/4 and 8/8,
and Chinese Search/locate/bbox checks still pass on 8/8, 8/8 and 80/80 pages.

Local run evidence:

- Pair/counter report: `/tmp/docatlas-batch24-heading-pairs.2sVjDr`, exit 0,
  11 cases, no quality gaps, empty stderr.
- Unchanged four-case report: `/tmp/docatlas-batch24-flash-quality.Lw05xR`,
  exit 0, no quality gaps, empty stderr.
- Focused regression log: `/tmp/docatlas-batch24-flash-tests.9zEPmC`,
  48 passed in 99.66 seconds: 30 pure guard/generator, six real pairs, eight
  existing raw/merge/provider and four existing quality tests.
- Source-admission hardening then passed 41 pure tests (the same 30 plus 11 new
  dirty/ignored/pinned-blob/symlink/FIFO cases) in 0.73 seconds. The producer was
  not rerun: strict `--check` still verifies the identical 83 files/25 functions.
- Measured provider fingerprint:
  `b65de55c86a6b700a804f1d39ca925eb083ac8fb3a5dfa6cdd66674ef59f39cb`.
  Patch-manifest SHA-256:
  `7cbf0bf05e53c08a01b4db4bc7b4f676f29daedf571b0c15edd5e9722080a7a9`.

The producer now checks clean HEAD/status and the exact pinned Git file set,
rejects ignored extra code/data and symlinks, and captures only regular files
whose bytes match pinned Git blobs. Original upstream hashes remain in
provenance, alongside explicit local before/after/helper hashes. All actual
published output fingerprints use SHA-256; Git's repository blob identity uses
its existing SHA-1 format. No dirty worktree bytes are presented as official source.

## Remaining gates

The specific generated cases now pass; this is not the full document-quality
release gate. New documents may still legitimately produce an explicit empty
tree, without revoking original-PDF Read, search or evidence resolution. Do not
invent headings to make additional corpora pass.

Legacy-vs-Flash quality comparison, summary/expand/full real-model evaluation,
OCR/Type-3/complex layouts, unbounded/very large corpus indexing strategy,
longitudinal semantic relevance, production-default routing and statistical
latency/RSS comparisons remain unmeasured. No model-quality result is inferred
from these zero-model deterministic checks.
