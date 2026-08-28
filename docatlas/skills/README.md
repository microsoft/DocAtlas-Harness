# DocAtlas Skills

DocAtlas ships four valid [Agent Skills](https://agentskills.io/) that share a
small runtime library in `_common/`:

| Skill | Purpose |
|---|---|
| `search` | Locate candidate pages by navigating a PageIndex tree. |
| `read` | Read page text, page images, and extracted figures. |
| `note` | Save page-grounded findings to session state. |
| `review` | Recall the saved notes relevant to a focused query. |

## Validate the skills

```bash
for skill in search read note review; do
  uvx --from skills-ref agentskills validate "docatlas/skills/$skill"
done
```

## Use them with the harness

The harness creates and maintains session state automatically:

```bash
uv run --locked harness chat \
  --skill search --skill read --skill note --skill review \
  --pdf document.pdf \
  --tree-json document_structure.json \
  --message "What are the report's main conclusions?"
```

## Run a skill directly

Keep the four skill directories and `_common/` as siblings. `read` can operate
without session state:

```bash
cp -R docatlas/skills/{search,read,note,review,_common} /path/to/agent/skills/
```

Point the agent runtime at the four Skill directories; `_common/` is a shared
library and is not itself a Skill.

```bash
uv run --locked python docatlas/skills/read/scripts/run.py \
  --pdf data/sample_pdfs/sample_report.pdf --pages 1,3
```

Create a session before calling the stateful skills directly:

```bash
export HARNESS_SESSION_FILE="$(uv run --locked harness init-session \
  --pdf document.pdf --tree-json document_structure.json \
  --question 'What are the main conclusions?')"

uv run --locked python docatlas/skills/search/scripts/run.py \
  --query "Locate sections containing the report conclusions."
uv run --locked python docatlas/skills/note/scripts/run.py \
  --found "The conclusion appears on page 12." \
  --evidence '[{"type":"text","source":"Page 12","content":"..."}]'
uv run --locked python docatlas/skills/review/scripts/run.py \
  --query "conclusion evidence"
```

`search` and `review` use the auxiliary Azure OpenAI configuration documented
in [`.env.example`](https://github.com/microsoft/DocAtlas-Harness/blob/main/.env.example).
See [ARCHITECTURE.md](https://github.com/microsoft/DocAtlas-Harness/blob/main/ARCHITECTURE.md)
for the CLI and session contracts.

## Add a skill

Each skill directory contains:

```text
skill-name/
├── SKILL.md
├── tool.json
└── scripts/run.py
```

Use a lowercase directory and matching `name` in `SKILL.md`. Keep portable
runtime code under `docatlas/skills/_common/`; code there must not import agent-runtime modules.
