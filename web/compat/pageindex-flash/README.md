# Reviewed PageIndex Flash adjustment

The upstream source remains the pinned, read-only `.sources/pageindex` checkout.
The product uses a finite generated vendor, not the whole SDK or a second chat
loop. This directory owns one local source-backed navigation adjustment, not a
new upstream release.

- [Patch manifest](numbered-headings.patch.json): exact source/output hashes and
  single-match replacement hunks for `flash/main.py` and `flash/embedded_toc.py`.
- [Guard source](numbered_headings.py): a bounded stdlib-only helper mechanically
  copied into the vendor. Never edit its generated copy.
- [ADR-051](../../docs/adr/051-flash-numbered-heading-guards.md): rationale,
  conservative recognition/source-support rules and acceptance boundaries.

The title guard only preserves an existing styled, cross-page, consecutively
numbered heading cohort for the normal detector. The bookmark guard only admits
an entire original flat cohort whose exact titles are printed on their own
target pages. It does not synthesize headings, rewrite PDF content, relax source
permissions or manufacture Evidence. File/page labels, invalid targets and
unsupported bookmark titles remain negative cases.

After explicit review, the designated producer runs:

```sh
env -u VIRTUAL_ENV uv run --locked --project python/docatlas-sidecar python scripts/vendor_flash.py
env -u VIRTUAL_ENV uv run --locked --project python/docatlas-sidecar python scripts/vendor_flash.py --check
```

Never run this producer concurrently with consumers of vendor files. Packaged
runtime copies are updated only by the existing coordinated build/sync stage.
Before any copying, the generator requires clean pinned HEAD/status and the
exact selected `git ls-tree` file set. Ignored extra code/data are not accepted
just because status is clean. No-follow descriptor reads reject symlinks and
nonregular files; bounded captured bytes must match their pinned Git blob and
are reused throughout generation instead of rereading the worktree.
The generator retains upstream `copiedSourceHashes`, records manifest/helper and
per-file before/after provenance, and verifies exact output hashes. A patch
change yields a new provider fingerprint/generation; it does not migrate old
trees. Future upstream changes must re-review the hunks, helper and fixed hashes
instead of applying a fuzzy patch or replacing the source checkout in place.

The [paired PDF gate](../../scripts/evaluate-flash-heading-pairs.py) is independent
of the earlier [four-case gate](../../scripts/evaluate-flash-quality.py): original
negative examples remain intact, and model/real-corpus quality is not inferred
from either generated-document evaluation.

Batch24's focused post-generation gates passed: all 11 pair/counter cases and
the original four cases, with exact source-title/page checks. See the
[current evaluation record](../../evals/flash-quality/README.md#batch24-reviewed-numbered-heading-adjustment)
for hashes, logs and the remaining real-corpus/model-quality limits.
