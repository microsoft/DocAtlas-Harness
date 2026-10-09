# 商业文档理解系统研究：从 Source-grounded Chat 到 Agentic Work Product

> 调研日期：2026-08-29  
> 方法：优先使用产品官方帮助、产品页与技术文章。营销方自行报告的规模、准确率或客户成效只作为产品定位信号，本文不把它们当作独立验证结果。  
> 名称说明：Google 帮助中心在本次调研时已使用 **Gemini Notebook**，它是用户熟悉的 NotebookLM 产品线当前名称。

## 结论先行

商业市场已经从“上传 PDF 后聊天”分化成四条路线：

1. **Source-to-Studio**：Gemini Notebook 把选定 sources 转成 chat、notes、mind map、audio、video、quiz、slides 等多种产物。
2. **Native Document Workflow**：Adobe 让引用、比较、审阅、分享和签署都发生在 PDF/合同原生工作流里。
3. **Scoped Knowledge Workspace**：Copilot、ChatGPT、Claude 用 project/notebook 把 sources、instructions、chat 与权限装进持久工作空间。
4. **Structured Professional Work**：Hebbia、Harvey、Elicit 把抽取和推理放进表格、列级工作流、评论、flag、签核、报告与团队交接。

它们正在共同收敛到：

```text
curated sources
  → scoped workspace
    → agentic search / analysis
      → interactive intermediate work
        → cited deliverable
          → persistent project and personalization
```

但市场仍有一个普遍空档：**citation 通常是答案的装饰或跳转，不是一个独立、可修订、可反驳、可复用的事实对象**。同一个 notebook 生成 report、slide、audio 时，往往是每种 artifact 再从 sources 生成一次；人的修订也常只改产物，没有反馈到共享事实层。

DocAtlas 的差异化路线因此应是：

> **One evidence model, many views.** 原文先形成可解析的 Evidence，再形成可版本化的 Claim；chat、比较表、brief、timeline、slide 或 audio 都编译自同一份 Claim Ledger。个性化改变阅读和表达策略，但不能改变 Claim 的支持关系。

## 1. 能力比较

| 产品 | Source 边界 | 关键交互 | 主要产物 | 追踪方式 | 对 DocAtlas 的启发 |
|---|---|---|---|---|---|
| Gemini Notebook | 用户勾选 sources；可搜索/Deep Research 后选择导入 | citation hover/click、mind-map node 提问、Audio Join、quiz feedback | note、report、mind map、audio/video、quiz、slide | chat 引用可直接到 quote；saved note 保留 citation | source 控制 + 多模态 Studio；但派生产物转回 source 时必须保留 lineage |
| Adobe Acrobat / PDF Spaces | PDF、扫描件、合同集合 | PDF 内跳转、合同识别、版本/多合同比较、审阅签署 | overview、key terms、comparison、cited answer | clickable citation 回 PDF；结构模型强化 PDF 理解 | 原文 viewer 与业务动作不能割裂；document type 可触发专门 workflow |
| Copilot Notebooks | 只使用 notebook references 与权限可见内容 | live references、custom instructions、Capture 会话/白板 | answer、draft、audio、mind map、Copilot Page | workspace 权限和 live reference；官方仍要求人工复核 | source 是活对象而非一次上传；非文档现场信息也能进入项目 |
| ChatGPT Projects / Deep Research | project files/sources/instructions；每个 chat 独立 outcome | clarification、prompt rewrite、background research、tool trace、browser annotation | cited research report、文件和项目 deliverable | tool calls + clickable inline citations；项目共享 sources | 长任务先澄清再计划；annotation/approval 是 Agent 操作界面 |
| Claude Projects / Research / Artifacts | project knowledge；超限自动切 RAG | project search tool、Research、artifact 选区编辑/版本、interactive inputs | cited research、editable artifact、interactive visual | Research citations；past-chat citations；artifact version | instructions / knowledge / skills / memory 分层；产物应可局部编辑而非全量重生 |
| Hebbia Matrix / Projects | 私有文档、数据源、历史工作与外部 feeds | row/column prompts、conditional columns、comments/flags、human checkpoint | matrix、memo、deck、model、always-on workflow | cell-level/sentence citations、每个数字来源、activity feed | 结构化中间态和 sign-off 比聊天更适合高风险专业工作 |
| Harvey II / Vault | legal matter/Space 的文档、任务、权限、历史 | review table、conditional columns、manual input、flags/comments、任务交接 | first-pass review、contract table、legal report | sentence citation、memory 像 source 一样被引用、matter history | matter context、个人 memory、团队 playbook 要分层；记忆使用也必须可见 |
| Elicit | 科研数据库、论文、上传材料 | paper selection、screening、column extraction、定制 report | evidence table、systematic review、report | AI claims 有 sentence-level citation | “More than chat”：claim extraction、screening 和 table 是一等工作流 |
| LiquidText / MarginNote | 用户主动阅读的原文集合 | 摘录、连接、批注、source round-trip、mind map、flashcard | 人工知识图、笔记、报告 | excerpt 与原页双向链接；AI 建议先接受/编辑/拒绝 | 人的阅读动作应直接产生可追踪知识，而不是只能向 Agent 发自然语言 |

## 2. Gemini Notebook（NotebookLM）：Source-to-Studio

### 2.1 真正强的不是问答，而是 source scope

[Gemini Notebook 概览](https://support.google.com/gemininotebook/answer/16164461?hl=en)把产品定义为 source-grounded research assistant。用户可以导入 PDF、网页、YouTube、音频、Google Docs/Slides 等；回答以 sources 为边界。

[Chat 帮助](https://support.google.com/gemininotebook/answer/16179559?hl=en)确认了几个特别重要的交互：

- 每个 source 有 checkbox，可明确纳入或排除本题；
- citation 直接使用 source 中的 quote、text 和 image；
- hover citation 可立即看完整 quote；click citation 自动定位到 quote 的上下文；
- chat style 与 answer length 可配置；
- chat response 可 `Save to note`，表格和 clickable citation 一起保留；
- 高级 chat 能搜索 Web、运行代码、生成文件/图表/图片，显示 thinking steps，并允许 stop/revise。

这里最值得复制的不是 checkbox 外观，而是 **每次推理都有明确 source set**。DocAtlas 的 Investigation 应保存 `sourceScopeVersion`，答案能解释本轮纳入和排除了什么。

### 2.2 Studio 把“理解”变成多种使用方式

官方帮助列出的 Studio 产物包括：

- [Mind Map](https://support.google.com/gemininotebook/answer/16212283?hl=en)：展开/折叠、选 node 后直接在 chat 中提问；
- [Audio Overview](https://support.google.com/gemininotebook/answer/16212820?hl=en)：按主题、受众、长度和语言定制；播放时可以 Join，用声音追问，回答后回到原节目；
- [Video Overview](https://support.google.com/gemininotebook/answer/16454555?hl=en)：格式、语言、视觉风格、focus prompt；后台生成；
- [Flashcards / Quizzes](https://support.google.com/gemininotebook/answer/16958963?hl=en)：难度、提示、解释、Got it/Missed it 和只重练错题；
- [Infographic](https://support.google.com/gemininotebook/answer/16758265?hl=en)与 [Slide Deck](https://support.google.com/gemininotebook/answer/16757456?hl=en)：可定制受众、风格、详略和 focus，并在后台生成。

这说明“文档理解”不是一个 answer box，而是让同一知识在阅读、听觉、视觉、练习和交付之间转换。尤其值得注意：Audio 的 Join 和 Mind Map node question 都不是静态 artifact，而是 **artifact 内的操作重新进入 Agent 对话**。

### 2.3 Notes 是知识循环，也是风险点

[Notes 帮助](https://support.google.com/gemininotebook/answer/16262519?hl=en)支持：

- 人写 note；
- chat response 保存成不可编辑 note；
- note 组合、反馈、摘要、outline、study guide；
- 单个或全部 notes 转成 sources。

“derived output → source”很强，但如果不保留 provenance，会产生循环支持：模型生成的 note 以后可能被当作 source 再支持它自己的结论。DocAtlas 允许 artifact/note 进入 source set 时，必须标记：

```text
source role = primary | imported | user-authored | model-derived
wasDerivedFrom = claim/evidence ids
no-self-support = artifact cannot verify an ancestor claim
```

### 2.4 Source discovery 的正确控制点

[Sources 帮助](https://support.google.com/gemininotebook/answer/16215270?hl=en)显示 Fast Research / Deep Research 可以找来源，但用户在结果页选择哪些 report/source 真正导入。Google Drive source 还会持续同步，而普通 upload 是 copy。

DocAtlas 应采用同样的两阶段：Agent 可以发现 candidate source，但 **进入 Investigation 的 source set 是一个可审计的人类/策略决定**。同步 source 更新时创建新 revision，不能覆盖旧引用。

### 2.5 Notebook 路线的边界

- Studio artifact 官方都提醒可能存在事实或视觉错误；
- Slide 的局部 revision 当前明确说明不会参考 sources；
- chat citation 很强，但 artifact 间没有公开的共享 claim lifecycle；
- note 转 source 会模糊 primary evidence 与 derived synthesis；
- 很适合个人研究与学习，但不是天然的专业 sign-off ledger。

DocAtlas 不应把 Audio/Slides 当第一阶段卖点；应先保证任何 artifact 都能回到共享 Claim Ledger。

## 3. Adobe Acrobat AI Assistant / PDF Spaces：原文即工作流

Adobe 的核心优势不是更强的聊天，而是 PDF viewer、OCR、评论、分享、签署与 AI 在同一产品里。

[合同能力公告](https://news.adobe.com/news/2025/02/acrobat-ai-assistant-contracts)描述了：

- 自动识别合同，包括扫描件；
- 生成合同 overview、key terms 和 document-specific suggested questions；
- plain-language answer + clickable citation；
- 比较最多十份合同，识别版本差异和一致性问题；
- 从理解继续进入 stakeholder review 和 e-signature。

[PDF Spaces 团队示例](https://experienceleague.adobe.com/en/docs/document-cloud-learn/acrobat-learning/get-started/ai/pdf-spaces-legal)把多份 policy、memo、regulatory guidance 集中在一个 workspace，并强调 cited insights、highlighted changes 和 auditable summary。

对 DocAtlas 的启示：

1. document type 应触发不同 extraction/verification schema，例如 contract、paper、financial report；
2. citation jump 必须发生在原文 viewer，而不是打开一个孤立 text snippet；
3. “理解”后应有业务动作：标记条款、分派复核、请求签核、比较 revision；
4. scanned/OCR evidence 必须同时保留 page image，因为 OCR quote 本身不是最终事实。

## 4. Microsoft Copilot Notebooks：活引用与工作现场

[工作原理](https://support.microsoft.com/en-us/microsoft-365-copilot/how-microsoft-365-copilot-notebooks-works)把 Notebook 定义为 scoped workspace：只使用显式加入的 references，不默认访问整个 OneDrive、邮件、Teams 或 Web；reference 更新时，项目上下文随之更新。

值得注意的设计：

- [Add references](https://support.microsoft.com/en-us/microsoft-365-copilot/add-references-to-your-microsoft-365-copilot-notebook)：文件、folder、site、URL、OneDrive；权限跟随原系统；直接加入特定文件可避免大 folder 中的 relevance selection 漏掉它；
- [Custom instructions](https://support.microsoft.com/en-us/microsoft-365-copilot/provide-custom-instructions-for-your-microsoft-365-copilot-notebook)：focus、tone、format 是 notebook-level policy；
- [Capture](https://support.microsoft.com/en-us/microsoft-365-copilot/capture-conversations-copilot-notebooks)：把线下谈话、白板照片、语音笔记和第三方会议 transcript 变成结构化 Copilot Page，再加入项目；
- [Mind Map](https://support.microsoft.com/en-us/microsoft-365-copilot/mindmap-copilot-notebooks)：node summary、Explain、继续在 Chat 中追问；
- shared notebook 的 reference 还涉及底层文件权限，而不仅是 notebook ACL。

DocAtlas 的 Source 不应只等于 PDF。用户选区、会议结论、人工笔记、网页 snapshot 都可以成为 source，但必须有 source role、actor、时间和权限。另一个重要教训是：当 corpus 很大时，“已连接 folder”不等于“本轮真的被 grounding”；UI 必须显示实际使用的 source subset。

## 5. ChatGPT Projects / Deep Research：长任务 Agent 的控制面

OpenAI 官方 [Projects 文档](https://learn.chatgpt.com/docs/projects)把 project 划分为共享 files/sources/instructions 与彼此独立的 chats；推荐一个 outcome 一个 chat，而不是把所有工作塞进一条长对话。这与 DocAtlas 的 `Collection/Investigation/Artifact` 分层一致。

官方 [Deep Research 指南](https://developers.openai.com/api/docs/guides/deep-research)显示了一个有用的三阶段：

1. clarification：先补齐目标、偏好和约束；
2. prompt rewriting：把需求变成完整 research brief；
3. agentic research：多步 web/file/MCP/code tool calls，最后给 inline citations。

输出保留 search/open/find、code、MCP、file-search 等 action items；长任务建议 background mode，并可用 `max_tool_calls` 控制成本。对 DocAtlas 而言，Agent 不应拿到一个模糊问题就立刻遍历文档：高成本、多文档或高风险任务要先形成可编辑 Investigation Brief。

[Browser 文档](https://learn.chatgpt.com/docs/browser)进一步展示了 annotation mode、区域选择、精细 styling feedback、site permission 和敏感动作确认。它证明了“在对象上直接指出问题”比在 chat 里描述位置高效得多。DocAtlas 的 PDF 选区、claim card、table cell 和 artifact section 都应能直接产生结构化 steering。

## 6. Claude：Knowledge、Instructions、Artifacts 与 Memory 的分层

### 6.1 Projects 与自动 RAG

[Projects](https://support.claude.com/en/articles/9517075-what-are-projects)包含独立 chat history、knowledge base 和 project instructions；[RAG for Projects](https://support.claude.com/en/articles/11473015-retrieval-augmented-generation-rag-for-projects)在知识接近 context limit 时自动切到 project knowledge search tool，并在 UI 显示 RAG indicator/tool call。

这体现了两个好原则：

- project instruction 与 project knowledge 分开；
- retrieval 是可见工具活动，不伪装成模型“记得”。

但 automatic RAG mode 由系统决定，对高风险文档产品而言还需要显示具体使用的 sources/passages 和遗漏范围。

### 6.2 Research 与 Artifacts

[Claude Research](https://support.claude.com/en/articles/11088861-use-research-on-claude)会跨 Web 和已连接的内部上下文做多步搜索，结果带 citations。用户可以 steering 指定内部来源。

[Artifacts](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them)是一个独立于 chat 的右侧工作面：

- artifact 可版本切换；
- Markdown 可选中文字后 `Edit with Claude`，无需在 chat 描述位置；
- 多文件 edit requests 可以批量进入下一条 message；
- 对话分支产生不同 artifact 路线；
- interactive artifact 可以接 MCP，首次使用需授权。

这给 DocAtlas 一个直接模式：Artifact 不是 answer 的附件，而是可选择、可局部修订、可版本化的工作对象。区别在于 DocAtlas 的每次 section revision 还要重新运行 claim coverage，不能只改文字。

### 6.3 Memory 的产品信号

当前 [Claude Memory 帮助](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context)显示：

- memory 是 topic 集合，不再只是每日总摘要；
- project 有单独 memory space 和 summary；
- past-chat search 是可见 tool call；引用旧 chat 时有 citation；
- sensitive topics 默认不存，用户需单独 opt in；部分信息永远不存；
- 用户可查看、编辑、删除 topic，pause/reset，或开 incognito；
- 删除源 conversation 当前不一定自动删除由它生成的 memory entry。

最后一点说明 citation 与生命周期必须真正连接。DocAtlas 的 memory provenance 不能只是 UI link：如果源被删除，应按 policy 变成 orphaned、redacted 或 cascade-delete，而不是保持一个看似有来源的 active memory。

## 7. Hebbia：Matrix 是 Agent 的可审查中间语言

### 7.1 从 chat 到 matrix

[Matrix](https://www.hebbia.com/matrix)把每份 contract/company/security 作为 row，把 extraction、判断、memo、spreadsheet 作为 columns。相比一次性报告，这种结构让用户看见缺失值、横向异常和每个 cell 的来源。

[Matrix 2.0](https://www.hebbia.com/blog/introducing-matrix-2-0)强调：

- 每个数字能看到来源和组合路径；
- workflow 的每个关键阶段有 human checkpoint；
- AI 继续生成 memo/deck/model，但专业判断留在人手里。

[Review Table 类似功能在 Harvey 的实现](https://www.harvey.ai/blog/collaborative-review-tables)进一步说明 conditional columns 可以形成 reasoning chain：先抽 governing law，再运行 jurisdiction-specific check；cell 显示 reasoning 与 sentence citation，用户用 flag、comment 和 manual input 做协作复核。

DocAtlas 应把 **Evidence Matrix** 作为 Claim Ledger 的一个 view，而不是新的数据孤岛：row 可以是 document/claim，column 可以是 schema question/verification rule，cell 引用 claim/evidence ids。

### 7.2 Projects 与 always-on agent

[Hebbia Projects](https://www.hebbia.com/blog/introducing-projects)将 documents、published chats、matrices、artifacts、instructions、permissions 和 activity feed 放进同一 living knowledge base；背景 agent 可以监听新文档并更新分析。

值得借鉴的是“private iteration → publish to project”：探索性分析不应自动污染团队知识。DocAtlas 的 Claim 要经历 `proposed → reviewed/verified → published`，只有 published artifact/claim 才进入 shared project baseline。

### 7.3 多 Agent 的事实接口

[Deeper Research 技术说明](https://www.hebbia.com/blog/inside-hebbias-deeper-research-agent)把 agent 分成 orchestrator、planning、retrieval、reasoning 等角色，并声称每条 claim 链接到原文 quote。它还指出 agents 之间只共享下一子任务必要信息，Output Agent 分段写完整 cited report。

对 DocAtlas 的关键不是复制“几十个 Agent”，而是定义它们交换的不是 prose summary，而是：

```text
TaskContract + EvidenceRefs + ClaimPatch + OpenQuestions
```

否则 context distillation 会把 provenance 丢掉。

## 8. Harvey：Matter、Review Table 和可引用 Memory

### 8.1 Matter context 与个人 memory 是两种东西

[Harvey II](https://www.harvey.ai/blog/introducing-harvey-ii)描述的 Space 包含 matter/project 的 documents、parties、tasks、permissions、history 和 ethical walls；Agent 在这个边界内继承工作上下文。个人 Memory 则携带“如何写 summary、要引用什么、如何表达”等偏好，跨 Web/Word/Outlook 使用。

这个分层与 DocAtlas 的目标高度一致：

```text
source facts ≠ matter/project context ≠ team playbook ≠ personal preference
```

任何“越用越懂你”都不能把客户/项目事实带到另一个 scope。

### 8.2 Memory 也要像 source 一样被引用

[Harvey Memory 公告](https://www.harvey.ai/blog/memory-is-here-harvey-personalized)提出了当前商业系统中最接近 DocAtlas 目标的交互：

- 明确说“remember”或 prompt 表达稳定偏好时，显示 confirmation card；
- Memory 集中查看、搜索、编辑、删除或整体关闭；
- Memory 影响 response 时像 source 一样显示 citation；
- 用户知道保存了什么、何时学到、何时使用；
- 当前先做个人 scope，再考虑 shared-space/organization memory。

这验证了 `why-used` 不是附加设置页，而应出现在每次被影响的 output 上。DocAtlas 还要比这一层更严格：memory citation 只能说明“为什么采用这种呈现/工作策略”，不能拿来证明 document claim。

### 8.3 人与模型互补，而非最后看一眼

[Harvey Contract Intelligence benchmark](https://www.harvey.ai/blog/contract-intelligence-benchmark)报告的产品评测发现：其数据集上 lawyer + Review Table 比单独 lawyer 或 LLM 高至少约 5%；这属于厂商自报结果，但失败分析很有启发：

- LLM 容易越过“合同四角”，对被引用但未提供的协议做合理却不可确认的猜测；
- LLM 也会过度字面推理，把 consent 与 notice 等层级关系处理得不符合法律工作习惯；
- 人的价值在于识别材料边界、压缩层级、处理含糊和签核。

因此 DocAtlas 的 human-in-the-loop 不能只在最终 answer 提供 thumbs down；人应能在 claim/cell 层：纠正范围、声明 unknown、合并层级、补充 evidence、拒绝越界推理。

## 9. Elicit 与主动阅读工具：Chat 之外的知识动作

[Elicit](https://elicit.com/)把 scientific research 的核心放在 paper selection、screening、data extraction、interactive table 和 systematic-review-like report，并声明 AI claim 带 sentence citation。用户可改变纳入哪些论文、抽取哪些字段。这说明高质量 research product 的基本对象是 evidence row/column，而不是 conversation turn。

[LiquidText](https://www.liquidtext.net/features)把 workspace 放在原文旁边，摘录跨页/跨文档连接，点击即可回到 original context。[MarginNote](https://www.marginnote.com/)让同一个 card 同时是 PDF excerpt、mind-map node 和 flashcard，并规定 AI suggestion 在进入知识图前可以 accept/edit/reject。

这些非 Agent 产品揭示了一个常被 AI 产品忽略的事实：**用户不是只负责提问；用户在阅读时一直在分类、连接、判断和重构信息。** DocAtlas 必须把这些动作变成一等 API。

## 10. 商业系统共同缺口

### 10.1 Citation existence 不等于 factual support

[FActScore](https://arxiv.org/abs/2305.14251)发现长回答一个句子经常混合 supported 和 unsupported pieces；它把回答拆成 atomic facts 再逐一检查。论文还观察到 citation 是否存在与事实支持并不天然相关。

[ALCE](https://arxiv.org/abs/2305.14627)进一步区分：

- correctness：答案是否正确且覆盖问题；
- citation recall/completeness：需要证据的 statement 是否都被支持；
- citation precision：给出的 citation 是否真的相关；
- fluency：输出是否可读。

商业 UI 多数只解决“有一个可点击 citation”，没有展示 atomic claim 的完整状态。

### 10.2 Artifact 之间容易事实漂移

chat、note、slide、audio、memo 若各自从 source 生成，会出现：

- 同一数字在不同 artifact 中表达不一致；
- 用户只修了 slide，没有修 report；
- 新 source revision 到来后，不知道哪些 artifact 过时；
- AI 生成 note 转回 source，形成循环引用。

DocAtlas 要用 ClaimVersion/ArtifactManifest 解决，而不是靠重新 prompt。

### 10.3 人的判断常没有结构化回流

flag、comment、edit 在很多产品里只是 presentation annotation。DocAtlas 应把可归纳动作变成 domain event：

```text
claim.accepted
claim.reworded
claim.split
claim.disputed
evidence.attached
evidence.rejected
scope.changed
artifact.published
memory.confirmed
```

这些事件既更新事实/工作流，也给个性化候选提供可靠监督信号。

## 11. 对 DocAtlas 的产品判断

### 应该学习

- Notebook 的 source checkbox、quote preview、click-to-source 和 artifact interactivity；
- Acrobat 的原文工作流和 document-type specialization；
- Copilot 的 live reference、permission inheritance 和 Capture；
- ChatGPT 的 clarification → research plan → long-running tool trace；
- Claude 的 instructions/knowledge/skills/memory 分层和局部 artifact edit；
- Hebbia/Harvey 的 structured intermediate state、checkpoint、comment/flag/sign-off；
- Elicit/LiquidText/MarginNote 的主动阅读与双向 source link。

### 不应该照搬

- 每种 Studio artifact 独立生成一套事实；
- 把所有项目知识自动注入每个问题；
- 把“AI 有 citation”当作 verified；
- 自动把 chat summary 升级为团队知识；
- 让 personal memory 证明 source fact；
- 让 background agent 静默改 published work；
- 只提供最终 answer 的 thumbs up/down。

### 推荐差异化

```text
NotebookLM      source-grounded multimodal studio
Acrobat         source-native PDF workflow
Hebbia/Harvey   structured professional workflow
DocAtlas        evidence-native, claim-tracked personal research agent
```

DocAtlas 的卖点不应是“支持更多文件格式”，而是：

> **每一个重要结论都知道来自哪一版原文、哪一段证据、经过什么推导、谁确认过、在哪些产物中被使用；同时 Agent 会逐步学会用户希望怎样找、怎样验证和怎样表达。**

