# ADR-051: Reviewed source-backed Flash numbered-heading guards

Status: reviewed and implemented for bounded Batch24 internal integration;
post-generation focused real-PDF gates passed. Full workspace/package validation
also passed (1275 Python tests, finite vendor and packaged provenance), as recorded
in the [integration tracker](../execution-tracker.md). No upstream upgrade or full R5 acceptance.

## Evidence

The [generated-PDF quality gate](../../evals/flash-quality/README.md) exposed two
specific heuristics at PageIndex pin `ae169566b3148792776531d987f543edcad92321`:
the first chapter was selected as a document title, whose fuzzy echoes removed
subsequent numbered chapters; repeated-topic `Chapter N: …` bookmarks were then
rejected as file-like enumerations. This is not a general Chinese-language or
running-header failure, and merge merely received an already empty raw tree.

A real isolated-provider 2×2 baseline, without changing text size/body/layout
apart from the named variables, measured:

| Independent cover | Repeated chapter subjects | Distinct chapter subjects |
| --- | --- | --- |
| Absent | 0/4 sections | 3/4 sections; first lost as document title |
| Present | 4/4 sections | 4/4 sections |

All four actual chapter blocks were 18pt against 12pt body text and passed early
resource/script/empty gates. The separate English control changed only bookmark
labels to `Chapter 1/2/3/4`: the unchanged page body then produced four hybrid
nodes. These synthetic controls establish causality, not real-corpus quality.

## Narrow reviewed local changes

1. Keep a proposed title eligible for existing heading detection only when it is
   the first of at least three actual, upper-page, one-line, non-body, non-header
   blocks with the same style/size and consecutive content-unit numbers on
   strictly increasing pages. Do not globally disable title/echo detection, add
   a title, synthesize a tree or turn navigation into Evidence.
2. If upstream bookmark classification is `IGNORE`, permit a skeleton exception
   only for the entire original unmodified flat entry set: at least three,
   matching content units, consecutive numbers, strictly increasing valid target
   pages and each whole title printed as a line on its exact target page.
   Reject page/file counters, gaps, repeated/reversed pages or numbers, missing
   source text, neighbouring-page-only support, nested/rewritten entry sets and
   paragraph substrings. Existing upstream non-IGNORE decisions are unchanged.
3. The guard is deliberately conservative: bounded title length, candidate count,
   page-text size and total inspected text. It is not general OCR, fuzzy matching,
   arbitrary numbering recognition or a promise to recover every valid outline.

## Reproducible patch ownership

[The patch manifest](../../compat/pageindex-flash/numbered-headings.patch.json)
allowlists only `flash/main.py`, `flash/embedded_toc.py` and one mechanically
copied [stdlib-only guard source](../../compat/pageindex-flash/numbered_headings.py).
[The generator](../../scripts/vendor_flash.py) requires exact upstream/output
SHA-256, exactly one occurrence of every before-hunk, a pinned helper SHA and no
unknown targets/dependencies. It prepares changes in memory before publication;
there is no fuzzy patching or manual edit of generated files.

Generated provenance retains the original upstream `copiedSourceHashes` and adds
the patch-manifest hash, per-file before/after hashes and local helper provenance.
The source commit and upstream version remain unchanged. The changed provenance
naturally produces a new provider fingerprint/index generation; existing trees
are not rewritten, moved, duplicated or silently reused as the new provider.
The optimizer's extracted deterministic function bodies remain unchanged.

Generator admission additionally requires the exact HEAD and a clean Git status,
including untracked files, without printing dirty contents. Its selected file set
comes from pinned `git ls-tree`; ignored extra `.py`/`.json` inputs are rejected.
Each captured working file is opened through no-follow directory/file descriptors,
must be regular and bounded, and must match its pinned Git blob identity. The
generator uses those verified captured bytes throughout, not a later worktree
re-read. Therefore dirty or ignored worktree bytes cannot be mislabeled with the
official commit. These admission checks leave all 83 generated output bytes unchanged.

Root is the sole producer of shared vendor/packaged outputs during integration.
`--check` replays the identical transformation without writing. Existing packaged
sidecar synchronization and package-fingerprint checks continue to verify all
files enumerated by `outputHashes`.

## Acceptance gates

- Pure guard tests and exact-hash/allowlist/single-match generator negative tests.
- Same-byte pre/post 2×2 PDFs: title coverage and physical section ranges backed
  by actual source page text, with original missing cases preserved.
- Legitimate repeated-topic Chapter bookmarks versus printed page/file counters,
  fabricated titles, reversed/duplicate targets and unsupported entry sets.
- Existing raw/merge generation, original-PDF Read/Locator, limits/cancellation,
  finite-vendor and packaged-runtime regressions. No paid/model calls or new deps.

## Batch24 observed acceptance

The sole root producer generated 83 files (including provenance) and the unchanged
25 deterministic optimizer functions. `vendor_flash.py --check` passes, including
the subsequent clean/pinned-source admission hardening; no second generation was
needed for that tooling-only change.

- All 11 paired/adversarial real-PDF cases pass with every navigation title found
  through actual Read on its exact source page. The 2×2 sources match their
  [recorded baseline hashes](../../evals/flash-quality/heading-pairs-baseline.json):
  0/4 and 3/4 improve to 4/4; the two cover controls remain 4/4.
- Only the supported repeated-topic bookmark case becomes `hybrid`. Printed
  page/file counters, unprinted topics, reversed/duplicate targets and
  neighbouring-page-only support remain `detected` and do not gain admission.
- The original unchanged four-case quality corpus now passes raw/merge coverage,
  Chinese Search/locate and original-PDF bbox checks, including the 80-page case.
- 48 focused tests passed (30 guard/generator + 6 real pairs + 8 existing provider
  + 4 existing quality); after source-admission hardening, 41 pure tests passed
  (the same 30 plus 11 source-input cases). Ruff and guard strict mypy passed.

Detailed local logs, fingerprints and scope are in the
[quality record](../../evals/flash-quality/README.md#batch24-reviewed-numbered-heading-adjustment).
The earlier exit 2 result remains historical evidence, not the current measured
result. These successes do not close R5 real-corpus, OCR/complex layout, full
optimization/model quality or default-provider selection.
