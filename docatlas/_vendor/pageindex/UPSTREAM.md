# Vendored: pageindex

This directory contains a vendored copy of the [PageIndex](https://github.com/VectifyAI/PageIndex)
Python package by Vectify AI, used by DocAtlas's `uv run --locked docatlas build-tree`
command to construct PageIndex `*_structure.json` files from PDFs.

It is vendored (not installed via pip) because the upstream is not on PyPI
and shipping it inline saves users from having to clone a sibling repo.

## License

MIT License — see [`LICENSE`](./LICENSE), Copyright (c) 2025 Vectify AI.
This vendored copy is included under the same MIT terms; we keep the
original copyright notice intact.

## Upstream

- Repository: https://github.com/VectifyAI/PageIndex
- Vendored at: 2026-06-05 (snapshot of the in-tree copy that was at
  `../PageIndex/pageindex/` in this monorepo at that date)
- Upstream commit: the original in-tree snapshot was not recorded against a
  specific upstream commit. Treat this directory as a frozen release artifact;
  any future refresh requires a dedicated source and license review.

Snapshot SHA-256 values:

```text
77b6bab864c04a891364dc6d5d41a42e2f2ae0859794178e4fd94a8dac67b808  __init__.py
f0aa8ba90d7e5a42c99793d25582f05d639ce4630edd2d3d7595ed9d6db56eb8  config.yaml
f67708fc534dc46d70cd7c98673b65f82d23b4d37f424ade5bd3281443ec941c  page_index.py
86ebb8bc0cfd3df1248d037c75735825888aa84864a19c8a6f089dce5ca06790  page_index_md.py
7af170ad4ca42b6e606f61c63ac24e3be33338ef1fa1cca066dae3488a7791a7  utils.py
```

## What was modified

One local security patch: `PyPDF2` → `pypdf` (its drop-in successor) throughout
`utils.py`, to drop the deprecated PyPDF2 dependency (CVE-2023-36464 /
GHSA-4vvm-4w3v-6mr8 — possible infinite loop on crafted PDFs). Otherwise the
Python source is copied verbatim. The directory contains:

- `__init__.py` — re-exports `page_index_main`, `config`, `utils.*`
- `page_index.py` — text-mode tree construction
- `page_index_md.py` — markdown-aware variant
- `utils.py` — helpers (token counters, `set_enable_thinking`, ...)
- `config.yaml` — default runtime config (DocAtlas passes its own values
  to `config(...)` so this file is read for fallback defaults only)

## Why not a submodule

A submodule would require `git clone --recursive`, which is a usability
trap. We prefer the slight maintenance cost of a manual periodic sync.
Upstream PageIndex updates infrequently (~5 commits/year), so a snapshot
is a reasonable trade.

## Runtime dependencies

PageIndex's `requirements.txt` lists:

- `openai`, `pymupdf`, `pypdf`, `python-dotenv`, `tiktoken`, `pyyaml`,
  `azure-identity`, `pycryptodome`

All of these are captured by DocAtlas's `uv.lock`, so vendoring the source adds
no separate dependency installation step.
