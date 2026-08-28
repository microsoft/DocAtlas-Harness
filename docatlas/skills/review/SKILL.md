---
name: review
description: Use this skill to recall previously saved analysis notes by a natural-language query. An auxiliary LLM looks over all saved notes' cards (note_id, page_refs, found text) and selects only the relevant ones, which Review then returns in full. Triggers include "review the notes on topic X", "do we have evidence about Y in our notes", "pull the partisan-split notes", "summarize what we've found about ethics". Always prefer Review over re-reading pages when the information might already be in a note — it saves an expensive page-read round-trip. Requires at least one Note has been written in this session.
license: MIT
compatibility: Requires Python 3.10-3.13, the complete DocAtlas Skills bundle, a DocAtlas session file, and Azure OpenAI access.
metadata:
  author: Microsoft Research
  version: "0.3.0"
---

# Review — recall saved notes by query

The second half of the **Note / Review** pair. Note writes findings down;
Review pulls them back out. The mechanism: build a short "note card" per
saved analysis (id + page refs + `found` text), let an auxiliary LLM
select which cards match the query, and return the full rendered bodies
of those notes.

## When to use

* Before producing the final answer — ask Review for everything you
  learned that bears on the user's question.
* When you think you *might* have answered a sub-question earlier but
  don't want to scroll back through turns.
* Before a new Search — pulling prior notes on the topic first prevents
  re-asking queries you've already answered.

## When NOT to use

* No notes have been saved yet (`Review` will just tell you so).
* The information you need is clearly *not* in any note — Review only
  looks at saved notes, never at pages.

## Arguments

| Field | Required | Notes |
|---|---|---|
| `query` | yes | Focused recall question. Phrase it like a search query. |

## Output

```jsonc
{
  "text": "Selected 2 note(s) for query 'partisan ethics': …rendered notes…",
  "query": "partisan ethics",
  "selected_note_ids": [1, 3],
  "candidate_note_ids": [1, 2, 3],
  "rationale": "notes 1 and 3 mention partisan splits on ethics-related items…"
}
```

If no notes match, `selected_note_ids` is empty and `text` says so.

## Example

After a few turns with saved notes:

Direct calls require `HARNESS_SESSION_FILE`; see `../README.md`.

```bash
uv run --locked python docatlas/skills/review/scripts/run.py \
    --query "what did we learn about partisan splits on presidential ethics?"
```

## Failure modes

* `aux LLM call failed` — the Azure endpoint/credentials for the aux LLM
  aren't available. Check `HARNESS_AUX_LLM_*` / `AZURE_OPENAI_*` env vars.
* Empty selection on a query you *expect* to hit — re-phrase the query
  more specifically or widen it.

## Tips for combining with other skills

* **Note → Review**: write then recall. The natural pairing.
* **Review → final answer**: just before composing the answer, do one
  Review with the user's question as the query.
