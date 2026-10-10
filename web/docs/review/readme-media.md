# README demo GIFs

The Web and terminal GIFs use **DocAtlas's own paper**, not the fictional
widget report. They are new, separately edited loops made from the product
recordings retained in the final v9 promotional video. The original videos
are read-only inputs and have not been changed.

## What the demos show

- [Web UI](../../assets/web-ui.gif): upload the paper, ask about its contribution,
  read a cited answer, check the original PDF, and explore the document map.
- [Terminal](../../../assets/tui-demo.gif): select the paper, ask a question,
  follow Search / Read / Note, and inspect the saved finding and its evidence.

Both use a consistent macOS-inspired window, traffic-light controls, soft
desktop background, readable action captions, and an opening result frame.
They are **recordings of independent Linux sessions**, not native macOS
acceptance or cross-client session synchronization. The public Web launcher
still requires its documented Linux isolation and provider permissions.

**The terminal capture is an archived development TUI, not a feature-parity
recording of the current repository-root CLI.** It shows experimental
`Read locate` and `Read blocks` calls. The current root
[Read contract](../../../docatlas/skills/read/tool.json) instead accepts pages
and optional page/figure images; it does not expose those progressive modes.
The README labels this distinction next to the GIF. Its CLI commands describe
the actual root implementation, not the experimental tool calls in the clip.
The recording must not be used as acceptance evidence for root-CLI features.

The source recordings are archival promotional-demo material; the current
application's styling may differ. Tool results, answers, source pages, and
research records are not redrawn. Cuts, shortened waits, and reading holds
make the GIFs easier to follow; neither elapsed GIF time nor the old tool
timings establish current performance. No new model call or benchmark run
was made for this edit. The recordings are not independent model-quality
verification. Trees and chapter summaries remain navigation, not evidence.

The source video provenance identifies the paper as
[DocAtlas: Long-Document Understanding as Mutable-State Interaction](https://arxiv.org/abs/2608.07527),
with original PDF SHA-256
`69dc16fc994e1fd2118eb11df088d3eaadacdc03da7e6fbf380a52fef4f78fc3`.
That paper hash comes from the earlier verified production record, not a
new PDF download or ingestion in this edit. The PDF's authors, affiliations,
and text are unchanged in the recordings.

## Assets and reproduction

The GIFs loop indefinitely at 1440 × 960, with a 12-fps edit timeline.
The Web loop is 27.01 seconds / 3.82 MiB; the terminal loop is 28.01 seconds /
6.98 MiB. Both have been fully decoded and visually checked at key frames.
Static alternatives are available for reduced-motion reading:
[Web still](../../assets/web-ui.png) and
[terminal still](../../../assets/tui-preview.png).
The [machine-readable report](../../assets/readme-media.json) records input
hashes, exact source-time mappings, durations, frame counts, and output hashes.

The renderer uses the Web workspace's existing Playwright and OFL-licensed
DM Sans / Newsreader fonts, plus host FFmpeg/ffprobe. It adds no application
dependency, system font, model provider, or runtime behavior. The source MP4s
are not copied into the Git repository.

From `web/`, with the frozen dependencies and Chromium installed:

```sh
# Inspect key frames and layout before encoding.
bash scripts/pnpmw exec node scripts/render-readme-gifs.mjs \
  --web-source /path/to/web-capture.mp4 \
  --tui-source /path/to/tui-capture.mp4 \
  --stills

# Encode, verify, then replace the README GIFs and still images.
bash scripts/pnpmw exec node scripts/render-readme-gifs.mjs \
  --web-source /path/to/web-capture.mp4 \
  --tui-source /path/to/tui-capture.mp4 \
  --publish
```

The source hashes are pinned in the renderer: Web is the 50-second,
1280 × 720 clean capture preserved in v9; TUI is the 25-second, 1536 × 864
interface crop prepared for v8 and also used by v9. A different recording
requires an explicit provenance and edit-map review. Omitting both mode flags
renders verified output only into a fresh ignored `.cache/readme-gifs/`
directory; `--publish` is the explicit asset update.

Each render checks source identity, source time bounds, frame readiness,
caption/layout bounds, browser errors, GIF dimensions, frame count, duration,
infinite looping, a 12 MiB per-file size limit, and full FFmpeg decoding.
The palette reserves the red, yellow, and green window-control colors explicitly.
Intermediate video, extracted frames, and render logs remain ignored. The
ordinary Web `scripts/check.sh` remains a separate code/contract test gate.
