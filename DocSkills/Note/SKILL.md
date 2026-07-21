---
name: Note
description: Use this skill to record progress, partial findings, hypotheses, and page-anchored evidence while investigating a long document. Call Note aggressively — any time you read a page and confirm, narrow, or update your understanding of the user's question. Triggers include "jot that down", "save this finding", "note that page 7 says X", or (more often) implicit internal signals — you just learned something and want it recoverable later. Notes persist in the session and Review can select among them. Never paraphrase notes back from memory; write them as you go.
---

# Note — append a progress-analysis note

## ⚠️ EVIDENCE REQUIREMENTS (mandatory)

Every Note call MUST include at least one evidence item with `type:"text"`
containing an **EXACT QUOTE** copied verbatim from the source page — not a
paraphrase, not a summary, not numbers alone. The `source` field MUST include
an explicit page reference like `"Page 33"` or `"Page 12, Table 2"`.

**BAD vs GOOD example:**

```jsonc
// ❌ BAD — paraphrase, no page ref
{"type": "text", "source": "survey data", "content": "Most Republicans think the president can pardon himself"}

// ✅ GOOD — exact quote with page ref
{"type": "text", "source": "Page 7, Q24a", "content": "73% of Republicans and Republican-leaning independents say the president can legally pardon himself"}
```

If you cannot produce an exact quote, go back and Read the page first. Do not
Note from memory.

---

This skill is half of the **Note / Review** pair that gives a multi-turn
investigation a memory. It writes one structured entry per call — what
you found, what you plan next, and the evidence backing the finding —
into an append-only timeline stored on the session file.

## Why bother writing notes?

Long-document work is read-heavy. By the time you're at turn 8 you've
already seen pages 1, 3, 5, and 12; without notes you'd be lugging those
chunks around in every prompt. Writing a note lets the next turn keep
working from a short summary while the evidence stays addressable by
`note_id`. Review can then cherry-pick the notes relevant to a final
answer.

## When to use

* You just confirmed something concrete on a page (a number, a claim, a
  definition) — write a note with page-anchored evidence.
* You formed a hypothesis you might want to revisit later.
* You finished one sub-task of a multi-part question (e.g. "figured out
  partisan split on ethics") and are about to pivot to the next sub-task.
* You hit a dead end and want to record *that* it was a dead end (so you
  don't redo the same search).

## When NOT to use

* For trivia already obvious from the user's message.
* When the finding is purely speculative with no supporting page. Go read
  the page first, *then* note.

## Arguments

All fields are per-call (the model decides them). Pass via JSON:

```bash
python DocSkills/Note/scripts/run.py --json '{
  "found": "Page 7 shows Republicans +30pt more likely than Democrats to say president can legally pardon self.",
  "plan": "Next, check page 9 for the ethics-charges question.",
  "evidence": [
    {
      "type": "text",
      "source": "Page 7, partisan split table",
      "content": "Rep 55% / Dem 25% on pardon self"
    }
  ]
}'
```

| Field | Required | Notes |
|---|---|---|
| `found` | yes | 1-3 sentences. Page-anchor anything concrete. |
| `plan` | no | What you intend to do next. Helps reviewers. |
| `evidence` | recommended | List of `{type, source, content, filename?}`. |

### Evidence item shape

```jsonc
{
  "type": "text" | "table" | "image",
  "source": "Page N" | "Page N, <title>",
  "content": "quoted excerpt or caption",
  "filename": "for image items only"
}
```

## Output

One JSON object on stdout:

```jsonc
{
  "text": "Saved as note #2 (step 5). Total analyses so far: 2.\n\n[Step 5] …rendered note…",
  "note_id": 2,
  "step": 5,
  "analysis_count": 2
}
```

## Examples

**Example — save an anchored finding**

After Read returned page 7:
```bash
python DocSkills/Note/scripts/run.py --json '{
  "found": "73% of Republicans vs 31% of Democrats say the president has legal authority to pardon himself (Pew 2018).",
  "plan": "Cross-check with the partisan table on page 9.",
  "evidence": [
    {"type": "text", "source": "Page 7", "content": "Rep 73% / Dem 31% on self-pardon legality"}
  ]
}'
```

## Tips for combining with other skills

* **Read → Note**: after every meaningful page-read. Don't wait.
* **Note → Review**: when you're ready to synthesize — Review lets an
  aux LLM select the notes relevant to a question.
* **Automatic tree enrichment**: once a note with page references is
  saved, the harness automatically lifts its page-findings into the
  PageIndex tree, so a later Search sees them as hints. (No extra call —
  it happens on the post-Note hook when tree annotation is enabled.)
