# DocAtlas & XL-DocBench

Microsoft Responsible AI Transparency Documentation for Research  
Code & Data Release Readme

## Overview

**DocAtlas** is source code for agentic long-document understanding research. It provides a research harness in which AI agents can interact with long documents through document search, reading, note-taking, review, memory, and evaluation workflows.

**XL-DocBench** is a benchmark dataset for evidence-grounded extra-long document understanding. It was developed to evaluate how AI systems retrieve, combine, and verify evidence across long professional PDF documents, including multi-page, multimodal, cross-document, and unanswerable cases.

DocAtlas and XL-DocBench are released together to support reproducible research on document-centric AI agents and long-context document understanding. The release does not include model weights, hosted services, customer data, personal data, sensitive data, or Microsoft-owned data.

A detailed discussion of the project can be found in our papers:

- **DocAtlas: Long-Document Understanding as Mutable-State Interaction** — TODO: add paper link
- **XL-DocBench: Benchmarking Evidence-Grounded Extra-Long Document Understanding** — TODO: add paper link

## What Can DocAtlas Do?

DocAtlas was developed to support research on agentic document understanding. It provides a mutable document environment where an AI agent can search document structure, read selected pages, write source-grounded notes, review prior findings, and use the resulting state to answer long-document questions.

XL-DocBench is being released together with DocAtlas to enable users to reproduce benchmark results, compare document-understanding systems, and study limitations of current AI systems on evidence-grounded long-document tasks.

## Intended Uses

DocAtlas is best suited for research and experimental use in document understanding, multimodal reasoning, retrieval-augmented generation, and agentic AI systems.

XL-DocBench is intended to be used either together with DocAtlas or with other compatible document-understanding systems for benchmark evaluation.

DocAtlas and XL-DocBench are being shared with the research community to facilitate reproduction of our results and foster further research in long-document understanding and document-centric AI agents.

DocAtlas and XL-DocBench are intended to be used by researchers, developers, and domain experts who are independently capable of evaluating the quality, accuracy, and limitations of system outputs before acting on them.

## Out-of-Scope Uses

DocAtlas is not well suited for production deployment or autonomous decision-making without additional engineering, validation, monitoring, and safety mitigations.

XL-DocBench is not well suited for evaluating all document domains, languages, formats, populations, or real-world workflows. It focuses on long professional documents and evidence-grounded benchmark tasks.

There are few or no instances of many real-world document categories, non-English languages, personal user workflows, customer data, and sensitive private data in this dataset. As a result, XL-DocBench should not be used to claim general readiness for all document-understanding scenarios.

We do not recommend using DocAtlas or XL-DocBench in commercial or real-world applications without further testing and development. They are being released for research purposes.

DocAtlas and XL-DocBench were not designed or evaluated for all possible downstream purposes. Developers should consider their inherent limitations as they select use cases, and evaluate and mitigate accuracy, safety, privacy, security, and fairness concerns specific to each intended downstream use.

Without further testing and development, DocAtlas and XL-DocBench should not be used in highly regulated domains where inaccurate outputs could suggest actions that lead to injury or negatively impact an individual's legal, financial, employment, educational, healthcare, or life opportunities.

We do not recommend using DocAtlas or XL-DocBench in the context of high-risk decision-making, including law enforcement, legal, finance, healthcare, employment, education, or other sensitive contexts.

## Dataset Details

### Dataset Contents

XL-DocBench consists of benchmark instances based on publicly available third-party professional PDF documents and synthetic question-answer pairs generated from those documents.

Each instance may include:

- a question or task prompt;
- a reference answer or expected output;
- cited evidence pages or evidence annotations where applicable;
- answer type and verification rules;
- metadata needed for benchmark evaluation and reproducibility;
- a public source document, processed representation, or link/metadata for the original public source, depending on licensing and redistribution constraints.

The benchmark includes human-verified questions over long professional documents across multiple domains. It includes examples requiring evidence from multiple pages, multimodal evidence such as tables, charts, or figures, cross-document evidence, and unanswerable questions.

XL-DocBench contains links or metadata for external public data sources where applicable. Links are to the original public source documents used to construct the benchmark. Because those sources are maintained by third parties, their availability may change over time.

### Data Creation & Processing

XL-DocBench was created from publicly available third-party professional PDF documents. The source documents were not customer data, Microsoft proprietary data, private internal Microsoft data, or intentionally collected personal data.

The benchmark was created through a document-grounded synthetic generation and verification pipeline. Candidate question-answer pairs were generated from public source documents using GPT-5.4 and then filtered and verified. The synthetic data was designed to create new benchmark questions and answers grounded in the source documents rather than copying or redistributing source text as the benchmark output.

Dataset creation was carried out by members of the research team using a combination of automated methods, AI-assisted generation, filtering, and human verification.

Where licensing permits redistribution, the release may include public source PDFs or processed representations. Where redistribution is not appropriate or not preferred, the release may provide source URLs, document metadata, access dates, and scripts or instructions to obtain the documents independently.

### People & Identifiers

Data points in XL-DocBench do not correspond to individual people's private behaviors, personal opinions, demographics, or personal characteristics. The benchmark is built from public professional documents and synthetic QA pairs.

XL-DocBench does not intentionally include data pertaining to children.

The existing public documents used to create XL-DocBench were not selected to include personal data. However, because public professional documents may contain incidental references to individuals, users should review the dataset and source documents for their intended use case and apply appropriate privacy and data-protection practices.

XL-DocBench is not believed to contain information that could be used to directly identify private individuals beyond incidental information already present in public source documents.

### Sensitive or Harmful Content

The existing data used to create XL-DocBench was not selected to contain sensitive or private information such as racial or ethnic origins, sexual orientation, religious beliefs, disability status, political opinions, biometric or genetic data, criminal history, or private health data.

The existing data was not selected to contain offensive or harmful content such as sexual content, violence, hate, or self-harm. The dataset is focused on professional document understanding tasks.

Because the source materials are third-party public documents, the research team cannot guarantee that every source document is free from all sensitive, private, outdated, or potentially harmful content. Users should conduct additional review before using the dataset in settings with stricter privacy, compliance, or content-safety requirements.

XL-DocBench is not believed to contain sensitive or harmful content as a primary dataset characteristic.

### Other Processing

Duplicate, redundant, invalid, low-quality, or insufficiently grounded candidate examples were removed through automated filtering and researcher review.

The data was labeled or annotated with information such as answer type, verification rules, evidence pages, reasoning/task categories, and document metadata. Annotation and verification were performed through a combination of automated processing and human expert review.

The benchmark construction process included checks intended to improve answerability, grounding, and evaluation quality, such as no-context answerability checks, evidence verification, and review for ambiguity or unsupported answers.

## How to Get Started

To begin using DocAtlas and XL-DocBench:

1. Clone the DocAtlas code repository: TODO: add GitHub link.
2. Download or access XL-DocBench: TODO: add Hugging Face or dataset link.
3. Follow the installation, configuration, and evaluation instructions in the repository README.
4. Review this transparency documentation, the license, and any dataset-specific usage notes before using the assets.
5. Report benchmark results with the exact model, parser, retrieval configuration, prompt settings, tool configuration, and dataset version used.

Results may vary depending on the selected foundation model or multimodal model, document parser, retrieval method, prompt design, runtime environment, and evaluation configuration.

## Validation

To assess how effective XL-DocBench would be at its intended purpose, our team looked for whether benchmark examples were grounded in source documents, required realistic long-document evidence use, and could be evaluated with explicit evidence and answer-verification rules.

Specifically, we used a multi-step construction and verification process that included synthetic candidate generation from document structure, filtering, evidence annotation, and human verification for answer support, ambiguity, and evidence completeness.

A detailed discussion of our validation methods and results can be found in our paper at: TODO: add XL-DocBench paper link.

## Evaluation

DocAtlas was evaluated on its ability to support agentic long-document understanding through interactive search, reading, note-taking, review, and evidence-grounded reasoning.

A detailed discussion of our evaluation methods and results can be found in our paper at: TODO: add DocAtlas paper link.

### Evaluation Methods

We used task-level benchmark metrics to measure DocAtlas performance on long-document understanding tasks. These include accuracy or task-specific answer correctness metrics, along with benchmark-specific evaluation rules described in the associated papers.

We compared DocAtlas against direct-input and agentic/retrieval-based baselines using long-document benchmarks such as MMLongBench-Doc, FinRAGBench-V, LongDocURL, and XL-DocBench.

The models used during evaluation included GPT-5.4 and Qwen-family vision-language models in the configurations described in the paper. Results may vary if DocAtlas is used with a different model, parser, retriever, prompt, tool implementation, or training configuration.

The project was also reviewed through internal Responsible AI and release/onboarding processes. This transparency documentation summarizes intended uses, limitations, and responsible-use guidance for the code and data release.

### Evaluation Results

At a high level, we found that DocAtlas improved long-document understanding performance by enabling agents to interact with documents as mutable state rather than relying only on static full-context input or static retrieval. The evaluation suggests that better document interaction, evidence access, note-taking, and review mechanisms can improve performance on long-document tasks.

The evaluation also shows that current systems still struggle with extra-long professional documents, multi-page evidence, multimodal evidence, cross-document reasoning, and deciding when documents do not contain enough support to answer.

## Limitations

### Code

DocAtlas was developed for research and experimental purposes. Further testing and validation are needed before considering its application in commercial or real-world scenarios.

DocAtlas was primarily designed and tested for English-language document-understanding tasks. Performance in other languages may vary and should be assessed by someone who is both an expert in the expected outputs and a native speaker or qualified evaluator of that language.

Outputs generated by AI may include factual errors, fabrication, omission, unsupported claims, or speculation. Users are responsible for assessing the accuracy of generated content. All decisions leveraging outputs of the system should be made with human oversight and not be based solely on system outputs.

DocAtlas may inherit biases, errors, or omissions produced by its base model, auxiliary models, document-parsing tools, retrieval components, prompts, and runtime configuration. Developers are advised to choose appropriate models and tools carefully depending on the intended use case.

DocAtlas may use or be configured with external foundation models or multimodal models. Users should review the transparency notes, model cards, terms, and Responsible AI documentation for any model or service they use with DocAtlas.

DocAtlas may inherit biases, errors, or omissions characteristic of the documents and data used with it, which may be amplified by AI-generated interpretations.

There has not been a systematic effort to ensure that systems using DocAtlas are protected from all security vulnerabilities, including indirect prompt injection attacks, malicious documents, adversarial inputs, or unsafe tool use. Any systems using it should take proactive measures to harden their systems as appropriate.

DocAtlas can introduce additional cost and latency compared with direct-input methods because it uses multi-step document interaction and tool calls. Users should evaluate trade-offs between speed, cost, reproducibility, and accuracy for their intended setting.

### Data

XL-DocBench was developed for research and experimental purposes. Further testing and validation are needed before considering its application in commercial or real-world scenarios.

XL-DocBench primarily consists of English-language professional document instances. Performance conclusions may not transfer to other languages, informal documents, private enterprise documents, personal documents, or domains not represented in the benchmark.

XL-DocBench may contain errors, noise, ambiguous examples, incomplete annotations, or limitations introduced during source-document selection, PDF processing, synthetic QA generation, filtering, and human verification.

XL-DocBench may be missing coverage of many document types, languages, domains, user groups, professional workflows, and real-world deployment conditions.

There are few or no instances of customer data, private personal data, children's data, many non-English languages, and many sensitive real-world decision-making scenarios in the dataset. As a result, XL-DocBench should not be used to claim model readiness for those settings.

The ability to access external links in the dataset is beyond the control of the research team. If source documents are linked rather than redistributed, link rot or source-document availability changes may affect reproducibility.

XL-DocBench has not been systematically evaluated for all forms of sociocultural, economic, demographic, linguistic, or domain bias. Developers should consider the potential for bias as they select use cases, and evaluate and mitigate accuracy, safety, privacy, and fairness concerns specific to each intended downstream use.

XL-DocBench should not be used in highly regulated domains where inaccurate or incomplete outputs could suggest actions that lead to injury or negatively impact an individual's legal, financial, employment, educational, healthcare, or life opportunities.

XL-DocBench was not developed for use with a single fixed model. It may be used with different compatible document-understanding systems, but users should review the relevant model cards or transparency notes for any model used in evaluation.

## Best Practices

Better performance can be achieved by carefully configuring the document parser, retrieval pipeline, reading tools, model prompts, auxiliary models, and evaluation settings for the target benchmark or experiment.

We recommend using clearly defined benchmark splits and reporting the exact split, dataset version, model, prompt, parser, retrieval configuration, and evaluation script used in any published result.

We strongly encourage users to use LLMs/MLLMs that support robust Responsible AI mitigations, such as Azure OpenAI services. Such services continually update their safety and Responsible AI mitigations with the latest industry standards for responsible use.

For more on Azure OpenAI and related best practices, users should review:

- [What is Azure AI Content Safety?](https://learn.microsoft.com/en-us/azure/ai-services/content-safety/overview)
- [Overview of Responsible AI practices for Azure OpenAI models](https://learn.microsoft.com/en-us/legal/cognitive-services/openai/overview)
- [Azure OpenAI Transparency Note](https://learn.microsoft.com/en-us/legal/cognitive-services/openai/transparency-note)
- [OpenAI Usage Policies](https://openai.com/policies/usage-policies)
- [Azure OpenAI Code of Conduct](https://learn.microsoft.com/en-us/legal/cognitive-services/openai/code-of-conduct)

Users should:

- treat DocAtlas and XL-DocBench as research assets, not production-ready systems;
- review source documents, prompts, model outputs, and evidence before drawing conclusions;
- use human oversight for any consequential interpretation of results;
- avoid claims that benchmark performance demonstrates readiness for high-stakes deployment;
- apply content-safety, privacy, security, and prompt-injection mitigations when adapting the code;
- comply with applicable licenses, data protection regulations, organizational guidelines, and source-document terms;
- maintain versioned releases of code, data, and evaluation scripts for reproducibility.

It is the user's responsibility to ensure that the use of DocAtlas and XL-DocBench complies with relevant data protection regulations and organizational guidelines.

## License

MIT License.

Nothing disclosed here, including the Out-of-Scope Uses section, should be interpreted as or deemed a restriction or modification to the license the code is released under.

TODO: Confirm final license for both code and dataset before publication.

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft trademarks or logos is subject to and must follow Microsoft's Trademark & Brand Guidelines. Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship. Any use of third-party trademarks or logos is subject to those third parties' policies.

## Ethics

The dataset was constructed from publicly available third-party professional documents and synthetic QA generation. No new human-subject data collection was conducted for this release.

Dataset creation and annotation/verification activities were conducted by the research team and human reviewers for benchmark quality control. TODO: Add any applicable institutional review, consent, compensation, or internal review details if required for final publication.

## Contact

This research was conducted by members of [Microsoft Research](https://www.microsoft.com/en-us/research/). We welcome feedback and collaboration from our audience. If you have suggestions, questions, or observe unexpected or problematic behavior in our technology, please contact us at:

**Bei Liu**  
TODO: add project contact email or alias

If the team receives reports of undesired behavior/content or identifies issues independently, we will update this repository with appropriate mitigations.
