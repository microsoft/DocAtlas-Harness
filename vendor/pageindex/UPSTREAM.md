# Vendored: pageindex

This directory contains a vendored copy of the [PageIndex](https://github.com/VectifyAI/PageIndex)
Python package by Vectify AI, used by DocAtlas's `python -m harness build-tree`
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
- Upstream commit: (vendored from a working in-tree copy; not pinned to a
  specific git SHA. To re-sync from upstream, run:
  `git clone https://github.com/VectifyAI/PageIndex.git /tmp/pi && \
     rsync -av --delete --exclude __pycache__ /tmp/pi/pageindex/ vendor/pageindex/`)

## What was modified

Nothing. The Python source is copied verbatim. The directory contains:

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

- `openai`, `pymupdf`, `PyPDF2`, `python-dotenv`, `tiktoken`, `pyyaml`,
  `azure-identity`, `pycryptodome`

All of these are already pinned in DocAtlas's `pyproject.toml`, so
vendoring the source costs ~130 KB and adds **zero** new transitive
dependencies.
