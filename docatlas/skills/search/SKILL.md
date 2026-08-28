---
name: search
description: Use this skill FIRST whenever the user's question is about content in a long document that you haven't already located — the tree-search pass maps a natural-language query to a short list of suggested pages, which you then feed into Read. Triggers include "find where the report discusses X", "locate the section on Y", "which pages talk about Z", or any question about the document whose answer pages you don't yet know. Always prefer Search before brute-force Reading a page range you guessed at — Search is cheap, Reading every page is not. Requires a PageIndex tree JSON to have been loaded into the session via `--tree-json` at launch.
license: MIT
compatibility: Requires Python 3.10-3.13, the complete DocAtlas Skills bundle, a DocAtlas session file, and Azure OpenAI access.
metadata:
  author: Microsoft Research
  version: "0.3.0"
---

# Search — coarse filter over the document tree

Search is the discovery step. Given a question, it asks an auxiliary LLM
to walk the document's PageIndex tree and point at the node(s) most
likely to contain the answer. It returns:

- A short rationale (why these nodes),
- A list of `suggested_pages` covering those nodes' page spans,
- And updates `session.workspace.search_history` so future Search calls
  don't re-suggest the same pages.

The model picks nodes; the harness expands them to page numbers and
records them. Search does **not** read page content — that's what
`Read` is for.

## When to use

- At the start of investigating a new question, before any `Read` call.
- After a Review that came up empty — cast a wider net with a refined
  query.
- When jumping to a new sub-topic mid-investigation.

## When NOT to use

- You already know the exact page(s) — call `Read` directly. Search has
  no extra information over the tree alone.
- No tree was loaded into the session (you'll get a clear error telling
  you to pass `--tree-json`).

## Writing a good query

Tree search is LLM-driven, not keyword matching. Write full sentences
with concrete anchors:

- ✅ "Find sections discussing partisan splits (Republican vs. Democrat)
  on presidential ethics and transparency."
- ❌ "ethics"

Include: the entity/topic, the aspect (value, comparison, trend,
definition…), and any constraint (time period, group, unit).

## Arguments

| Field | Required | Notes |
|---|---|---|
| `query` | yes | Full-sentence natural-language query. |

## Output

```jsonc
{
  "text": "Tree search found 2 relevant node(s):\n  • [0003] …\n\nSuggested pages: 3, 4, 5",
  "query": "…",
  "suggested_pages": [3, 4, 5],
  "selected_node_ids": ["0003", "0007"],
  "rationale": "partisan splits on ethics appear in the survey-results section…"
}
```

If the tree is empty or the LLM returns no nodes, `suggested_pages` is
empty and `text` explains so.

## Example

Direct calls require `HARNESS_SESSION_FILE`; create it with `harness
init-session` as shown in `../README.md`.

```bash
uv run --locked python docatlas/skills/search/scripts/run.py \
    --query "Find sections comparing Republican and Democrat views on presidential ethics."
```

## Tips for combining with other skills

- **Search → Read**: the classic pair. Feed `suggested_pages` into
  `Read`'s `pages` argument. When MinerU/Docling markdown is available,
  Read returns structured markdown for cheaper (text-only) reading.
- **Search → Note**: after reading and writing a note with page
  references, the harness automatically lifts the finding back into the
  tree (as `page_findings`) so the *next* Search call benefits from it.

## Failure modes

- `Search requires a PageIndex tree` — you forgot `--tree-json` at the
  harness launch.
- `aux LLM call failed` — check `HARNESS_AUX_LLM_*` / `AZURE_OPENAI_*`
  env vars.
- `suggested_pages` empty on a query you expect to hit — rephrase with
  more specific anchors, or try a broader framing first.
