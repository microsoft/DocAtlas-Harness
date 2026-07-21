# DocSkills

Portable SKILLs for long-document understanding. Each skill is self-contained
and **must not import from `harness/`** — that's what keeps them usable from
Claude Code, DocAtlas, or any other LLM runtime.

## Skill roster

| SKILL | Purpose |
|---|---|
| `Search/` | Coarse filter: LLM-driven search over the document's PageIndex tree; returns candidate pages. |
| `Read/` | The single content tool: reads pages and returns text (MinerU/Docling markdown or PyPDF), optional page screenshots, and figure sub-images. |
| `Note/` | Append a structured progress note (found / plan / evidence) for the current task. |
| `Review/` | Recall previously saved notes relevant to a focused query. |

Two behaviors that used to be separate skills are now **automatic post-Note
hooks** in the harness, not model-visible tools:

- **Memory archival** — after a Note, stale Read outputs are replaced with
  compact placeholders to free context (opt-in via `--memory`).
- **Tree annotation** — a Note's page-findings are lifted back into the
  PageIndex tree so later Search calls see them as hints (opt-in via
  `--tree-annotate`).

`_common/` holds shared helpers (PDF text/image, markdown reader, note store,
session I/O, tree ops, figure filter, aux LLM client). It is **not** a SKILL —
the underscore prefix marks it.

## Skill template

```
DocSkills/<Name>/
├── SKILL.md          # YAML frontmatter (name + description) + LLM-facing prose
├── tool.json         # JSON Schema for the LLM-facing parameters
├── scripts/
│   └── run.py        # Single CLI entry; JSON over stdio
└── references/       # Optional, for progressive disclosure
```

## CLI contract

Base call (works in any harness, Claude Code via Bash included):

```bash
python DocSkills/<Name>/scripts/run.py <args...>
# stdout: { "text": "...", ... }
```

Optional DocAtlas extension fields are wrapped in `_harness_extras` so other
harnesses can ignore them safely (e.g. `images`, `session_patch`). See
[`../ARCHITECTURE.md`](../ARCHITECTURE.md) for the full contract.

## Adding a new skill

1. Create `DocSkills/<NewName>/` with the template above (SKILL.md + tool.json
   + scripts/run.py).
2. Add regression cases under `evals/<NewName>/evals.json`.
3. Load it at launch with `--skill <NewName>` (skills are resolved by name
   under `DocSkills/`).
