"""Evaluation scoring prompts (docatlas/scoring/score_mmlongbench_hybrid.py).

Experimental v2 (2026-04-29): tuned for observed pred_raw
patterns. Adds shortest-span, first-direct-answer, prefer-common-form,
sticky-abstention rules, plus targeted few-shots from observed failure modes.
"""

# System prompt for the answer extraction LLM call.
EXTRACT_SYSTEM_PROMPT = """\
Given the question and analysis, you are tasked to extract answers with required formats from the free-form analysis.
- Your extracted answers should be one of the following formats: (1) Integer, (2) Float, (3) String and (4) List.

Extraction rules (apply in order):
1. SHORTEST SPAN. Output the shortest span that exactly matches what the question asks for. Strip surrounding/qualifying words (e.g. "Europe IPO index value" -> "Europe IPO"; "Rear Adm. (Ret.) Tim Ziemer" -> "Tim Ziemer"; "lead (Pb)" -> "Pb"; "4G connectivity" -> "4G"; "liberal Democrats" -> "Liberal" if question asks ideology). Do not invent words that aren't in the analysis.
2. FIRST DIRECT ANSWER. If multiple candidates appear, prefer the one that most directly answers the question. A standalone declarative ("Analysis." / "The answer is X.") IS the answer even if longer hedging follows.
3. PREFER COMMON FORM. If the analysis offers two equivalent forms, pick the one matching the question's framing. "What color..." -> color name (not hex). "What hex..." -> hex.
4. STICKY ABSTENTION. If the analysis says "Not answerable" / "not stated" / "cannot be determined" / "the document doesn't say" / "this document says X, not Y" anywhere, output "Not answerable" — even if the analysis goes on to give a speculative alternative interpretation. The abstention always wins.
5. LIST NORMALIZATION. For Lists, strip modifiers ("dashed circle" -> "Circle"), normalize plural/singular, but keep the order from the analysis.
6. UNITS. For numeric answers, drop unit words unless the question explicitly asks for them.

Please make your response as concise as possible. Format:
```
Extracted answer: [answer]
Answer format: [answer format]
```

Read the examples, then extract the answer.
---
Question: List the primary questions asked about the services in this report.
Analysis: The primary questions asked about the services in the report for The Limes Residential Home are:\n\n1. Is the service safe?\n2. Is the service effective?\n3. Is the service caring?\n4. Is the service responsive?\n5. Is the service well-led?
Extracted answer: ['Is the service safe?', 'Is the service effective', 'Is the service caring?', 'Is the service responsive?', 'Is the service well-led?']
Answer format: List
--
Question: How many regulations of the HSCA 2008 are breached in all according to this report?
Analysis: According to the report, the provider breached 10 Health and Social Care Act 2008 (Regulated Activities) Regulations in total.
Extracted answer: 10
Answer format: Integer
--
Question: According to the survey that is the percentage of Chinese who are paying more or about the same attention to politics after Trump's election?
Analysis: The survey provided does not specify the percentage of Chinese individuals.
Extracted answer: Not answerable
Answer format: String
"""

# Template for the user message sent alongside EXTRACT_SYSTEM_PROMPT.
EXTRACT_QUERY_TEMPLATE = "Question: {question}\nAnswer format: {answer_type}\nAnalysis: {analysis}"

# Few-shot examples — targeted at observed flips_pos failure modes.
EXTRACT_FEW_SHOTS: list[dict] = [
    # SHORTEST SPAN: strip "index value"
    {
        "role": "user",
        "content": "Question: Which was greater at the time of the presentation, Europe IPO index value or US IPO index value?\n"
        "Answer format: Str\n"
        "Analysis: The Europe IPO index value was greater. From page 11's chart, Europe ends well above the U.S.",
    },
    {
        "role": "assistant",
        "content": "The question asks WHICH was greater. Strip 'index value' suffix.\n"
        "Extracted answer: Europe IPO\nAnswer format: String",
    },
    # SHORTEST SPAN: strip honorifics
    {
        "role": "user",
        "content": "Question: Who is the lead of the program?\n"
        "Answer format: Str\n"
        "Analysis: The program is led by Rear Adm. (Ret.) Tim Ziemer.",
    },
    {
        "role": "assistant",
        "content": "Strip honorifics, keep the personal name only.\n"
        "Extracted answer: Tim Ziemer\nAnswer format: String",
    },
    # FIRST DIRECT ANSWER: single-word reply
    {
        "role": "user",
        "content": "Question: According to the flowchart, what comes between Reporting and Action?\n"
        "Answer format: Str\n"
        "Analysis: Analysis.",
    },
    {
        "role": "assistant",
        "content": "The single-word analysis IS the direct answer.\n"
        "Extracted answer: Analysis\nAnswer format: String",
    },
    # PREFER COMMON FORM: color name over hex
    {
        "role": "user",
        "content": "Question: What is the color of the zone Mali in the map?\n"
        "Answer format: Str\n"
        "Analysis: Mali is colored #6A5ACD on that map — a purple/slate-blue shade.",
    },
    {
        "role": "assistant",
        "content": "Question asks for a color name, not a hex code.\n"
        "Extracted answer: purple\nAnswer format: String",
    },
    # SHORTHAND PHRASE
    {
        "role": "user",
        "content": "Question: According to the report, how do 5% of the Latinos see economic upward mobility for their children?\n"
        "Answer format: Str\n"
        "Analysis: According to the report, 5% of Latinos say their children will be less well off financially than they are.",
    },
    {
        "role": "assistant",
        "content": "The question asks HOW they see mobility — answer is a short description.\n"
        "Extracted answer: Less well-off\nAnswer format: String",
    },
    # LIST: strip 'dashed'
    {
        "role": "user",
        "content": "Question: What shapes illustrate the closure property?\n"
        "Answer format: List\n"
        "Analysis: The closure property is illustrated using a dashed circle and a dashed rectangle in the diagram.",
    },
    {
        "role": "assistant",
        "content": "Strip modifiers like 'dashed'.\n"
        'Extracted answer: ["Circle", "Rectangle"]\nAnswer format: List',
    },
    # STICKY ABSTENTION
    {
        "role": "user",
        "content": "Question: How many adults rated Trump's ethical standards in the April 2022 survey?\n"
        "Answer format: Int\n"
        "Analysis: Not answerable: this document says the survey was conducted April 25 - May 1, 2018, not 2022. In the 2018 survey, 36% of adults rated the ethical standards of Trump administration as poor.",
    },
    {
        "role": "assistant",
        "content": "The analysis abstains. The 36% figure is for a different question.\n"
        "Extracted answer: Not answerable\nAnswer format: Integer",
    },
]
