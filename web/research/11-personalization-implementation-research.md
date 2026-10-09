# DocAtlas 个性化实现研究与验证方案

> 状态：Research synthesis / implementation proposal，不是最终 ADR  
> 更新日期：2026-08-30  
> 关联文档：[长期记忆模型](03-personalization-memory.md)、[原生个性化架构提案](10-docatlas-native-personalization.md)  
> 研究结论：现有证据足以设计和验证 v0，但不足以直接冻结自动学习阈值、最终存储边界或宣称“越用越懂”。
> 受控 pairwise preference probe 与独立 Research Memory/Continuity 见
> [DocAtlas Memory 架构](14-adaptive-interface-research-continuity.md)。

## 1. 结论先行

当前方案不是“接入一个向量数据库，然后把相关用户信息塞进 prompt”。更准确的定义是：

```text
Personalization
  = governed memory
  + task-conditioned adaptation policy
  + observable use
  + outcome feedback
```

只做到存储和召回，系统最多是“记得用户”；只有能可靠地把记忆转成当前文档任务中的阅读、核验和
呈现决策，并从结果中纠正，才是“越来越懂用户”。

研究支持以下 v0 方向：

1. 保留细粒度 observation 及其 provenance，不只保存压缩画像；
2. 使用 version、scope、valid time 和 supersession 表达会变化的用户状态；
3. 召回先做 identity/scope/risk/use gate，再做 relevance ranking；
4. 让 memory 编译成结构化 `PersonalizationDecision`，而不是自由文本指令；
5. 每次应用写入 `MemoryUse`，并将用户纠正和任务结果回流；
6. 对 Evidence/Claim verifier 建立 personalization on/off non-interference gate；
7. 第一版使用 SQLite + FTS5 和确定性规则，embedding/graph/在线策略学习均延后到基线证明不足之后。

## 2. 调研充分度与证据等级

### 2.1 已经覆盖

- 长期对话记忆：抽取、索引、召回、时间更新、遗忘和 abstention；
- Agent memory：semantic/episodic/procedural memory、hot-path/background formation、可编辑 profile；
- 个性化 Agent：profile、memory、planning、tool/action 之间的传播；
- 安全：memory poisoning、跨域泄漏、sycophancy、tool drift、隐私与错误经验提升；
- 商业控制面：显式确认、topic/project scope、incognito、敏感信息 opt-in、why-used/citation；
- DSH 实现接缝：Session log、storage-domain、approval、pre-step recall、Web commands；
- DocAtlas 上游：Note/Review、search/read history 与 session JSON 的能力和缺陷。

### 2.2 仍然不足

公开研究大多评估“过去说过什么能否被找回”，而不是完整的专业文档研究过程。仍缺少可信答案的问题：

- 哪些阅读手势能稳定代表长期偏好，而不是当前任务的偶然行为？
- 如何证明一个 Search → Read → Verify 路径是可迁移的成功工作流？
- 个性化是否减少阅读成本，同时保持反证发现率和 citation precision？
- 用户目标或证据标准改变后，旧策略能否及时退出，而非形成路径依赖？
- 同一用户跨财务、法律、论文等领域时，哪些偏好可以安全迁移？

因此本文对资料采用三档证据：

| 等级 | 资料 | 使用方式 |
|---|---|---|
| A | 官方产品文档、固定源码和已复核本地实现 | 可用于描述当前能力和兼容边界 |
| B | 已发表或有公开 benchmark/code 的研究 | 可用于设计基线和复现实验 |
| C | 2026 年预印本、厂商性能数字和 position paper | 只作为风险信号或候选方法，不能直接当产品事实 |

后文引用的 2026 年 arXiv 工作大多属于 C 级；应先复现实验或至少审计数据与代码，再采用其算法或数字。

## 3. 研究地图及其对 DocAtlas 的含义

### 3.1 长期记忆不是长上下文

- [LongMemEval](https://arxiv.org/abs/2410.10813)将能力拆为 information extraction、multi-session
  reasoning、temporal reasoning、knowledge updates 和 abstention，并显示持续交互中有明显性能下降。
- [LoCoMo](https://arxiv.org/abs/2402.17753)覆盖最多 35 个 session 的长程对话，说明 long context 和普通
  RAG 仍难处理时间与因果关系。
- [Memora](https://arxiv.org/abs/2604.20006)进一步把遗忘和失效记忆纳入指标，报告现有系统经常继续使用
  obsolete memory。
- [StateMemBench](https://arxiv.org/abs/2608.19652)强调 current/superseded state，而不是只评估能否找到旧句子。

**对 DocAtlas 的含义**：必须保留 version chain、有效时间和当前状态；“最近或最相似”不能自动覆盖旧
记录，也不能把召回到旧偏好算作成功。

### 3.2 保存了反馈，不等于以后会正确使用

- [StreamMemBench](https://arxiv.org/abs/2606.14571)把 evidence recall、初次使用、反馈吸收和后续复用分开，
  其结果表明现有系统即使保存了信息，也常不能转化成未来任务中的正确行为。
- [FinPerMA](https://arxiv.org/abs/2608.04095)报告 summary memory 可能保留事实细节，却丢失真正决定个性化
  的偏好信号。
- [LUNAR](https://arxiv.org/abs/2608.05246)报告更多历史或更大模型并不保证更好；选择和整合相关行为证据
  是独立难题，细粒度行为记录可能优于压缩 memory。

**对 DocAtlas 的含义**：评测单位必须覆盖
`Observation → Candidate → Recall → Decision → Action → Outcome`，并能从 profile 回落到原始事件。

### 3.3 写入是证据治理问题

- [When Not to Write Memory](https://arxiv.org/abs/2607.02579)指出多次 Agent trace 可能依赖同一来源、同一
  prompt 或同一错误，重复次数不是独立支持。
- [Dynamic Cheatsheet](https://arxiv.org/abs/2504.07952)展示保存可迁移策略的潜力，但其任务设置不能证明
  未经验证的文档研究路径也可安全自我提升。
- [A-MEM](https://arxiv.org/abs/2502.12110)、[Zep/Graphiti](https://arxiv.org/abs/2501.13956)说明原子记录、
  动态链接和时间状态有价值，但“演化”不应在 DocAtlas 中原地改写旧来源。

**对 DocAtlas 的含义**：候选提升必须考虑 lineage、scope、反例和 outcome；Agent 自己的重复输出永远不能
成为独立证据。高影响候选宁可 `needs-review`，也不要追求自动写入率。

### 3.4 Recall 是安全边界，不只是相关性排序

- [Beyond Similarity](https://arxiv.org/abs/2606.06054)将 memory search 视为 trust boundary，并研究跨域泄漏、
  sycophancy、tool drift 和 memory-induced jailbreak。
- [Mitigating Over-Personalization](https://arxiv.org/abs/2608.08300)报告按 domain 结构化 memory context 可降低
  跨域干扰；其绝对收益需要独立复现，但方向与 scope-first 设计一致。
- [When Personalization Misleads](https://arxiv.org/abs/2601.11000)直接研究个性化诱发的事实偏移。
- [Privacy-Aware Memory](https://arxiv.org/abs/2608.16551)主张把 utility representation 与敏感原值隔离，并
  对读取实行任务和 consent 控制。

**对 DocAtlas 的含义**：不能把 vector top-k 直接注入 Agent。召回必须经过 profile、workspace、domain、
task purpose、sensitivity、状态与作用面门控；Document Evidence 与 Personal Memory 使用不同通道。

### 3.5 文档阅读个性化应优先发生在 selection 层

- [Selection, Not Salience](https://arxiv.org/abs/2606.10398)在 social highlighting 场景中发现，可测量的个性化
  主要来自 document/span selection；句子级 salience 个性化没有稳定超过非个性化基线。
- [Paper Copilot](https://arxiv.org/abs/2409.04593)探索 user profile + retrieval 的个性化论文助手，但公开证据
  仍不足以回答专业 Fact Trace 的安全问题。
- [LaMP](https://arxiv.org/abs/2304.11406)表明 personal profile retrieval 能改善多类生成任务，但不包含文档
  Claim/Evidence 的 non-interference 要求。

**对 DocAtlas 的含义**：首批学习目标应是 source/section order、representation、解释深度和工作流，而不是
让个人历史改变 canonical tree、原文显著性或 evidence support。

## 4. 商业产品和通用框架带来的边界

### 4.1 产品控制面

- [Harvey Memory](https://www.harvey.ai/blog/memory-is-here-harvey-personalized)采用显式/偏好提示后的确认卡、
  集中查看编辑删除，以及像 source 一样显示 memory use；这验证了专业场景中 why-used 的价值。
- [Claude Memory](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context)
  当前公开设计包括 topic entries、project boundary、past-chat citation、pause/reset、incognito 和敏感 topic
  opt-in；它也明确区分删除源对话与删除派生 memory。
- [OpenAI 官方 Memories 文档](https://learn.chatgpt.com/docs/customization/memories)将 memory 定义为 helpful
  recall layer，而把必须遵守的项目规则留在项目文档；同时区分“本次会话能否使用 memory”和“本次会话
  能否贡献给未来 memory”。本地 Codex memory 还采用 idle 后后台生成、secret redaction 和独立 use/generate
  控制，这些都是 DocAtlas 可借鉴的产品模式，而不是可直接复用的数据模型。
- [Gemini Notebook chat](https://support.google.com/notebooklm/answer/16179559?hl=en)提供 source checkbox、原文
  quote/click-to-source 和显式回答风格/长度设置，说明大量呈现偏好应直接配置，而不必由模型猜测。

### 4.2 通用框架

| 系统 | 值得借鉴 | 不能直接解决的部分 |
|---|---|---|
| LangGraph/LangMem | thread vs long-term store、profile/collection、semantic/episodic/procedural、hot/background formation | 没有 DocAtlas Evidence/Claim 与 promotion governance |
| Mem0 | extract/update pipeline、user/agent/run scope、procedural memory | 当前类型支持和平台实现不完全对称；普通 vector memory 不满足事实隔离 |
| Letta | core/archival memory、可持久 Agent state、上下文分层 | 允许 Agent 自编辑 memory 的默认模型不适合高影响用户画像 |
| AutoGen | 可替换 Memory protocol、query/update_context 事件可观察 | 示例实现容易把无关 preference 一起注入上下文 |
| Google ADK | session 与 long-term MemoryService 分离、显式 event/fact 写入、preload/on-demand recall | ingestion/retrieval 是基础设施，不定义文档研究语义 |
| MemOS | memory 作为带 provenance/version 的可管理系统资源 | 覆盖面很大，v0 引入多 memory representation 会增加不必要复杂度 |
| `dsh-native-memory` | storage-domain、approval、session seq provenance、bounded profile、secret guard | workspace facts 模型过通用，不是 DocAtlas Personalization Kernel |
| `dsh-memory-spaces` | source/consumer 分权、version lifecycle、FTS5、pre-send preview、usage audit | 面向共享会话 memory，仍缺少文档行为和 Claim outcome |

结论是：这些系统提供可靠零件和反例，但没有任何一个同时拥有
`DocumentRevision + Evidence/Claim + epistemic workflow + why-used + non-interference`。

## 5. 推荐的运行闭环

```text
DSH message/tool events + DocAtlas Web actions
                     │
                     ▼
            Observation Ledger
        raw ref + typed signal + lineage
                     │
        deterministic rules / bounded extractor
                     ▼
             Memory Candidate
       dedupe + scope + counterevidence
                     │
          policy gate / user confirmation
                     ▼
             MemoryVersion Ledger
                     │
       task-conditioned recall admission
                     ▼
          PersonalizationDecision
                     │
          DSH executes visible actions
                     ▼
       MemoryUse + research Outcome
                     │
                     └──── correction / utility evidence
```

这个闭环中的模型调用都由 DSH 执行并进入 trajectory；DocAtlas Core 负责验证 payload、状态转换、policy 和
持久化。不能在 sidecar 中偷偷运行“反思模型”。

## 6. 四个核心对象

以下是 contract 讨论用的最小草案，不是已批准 wire schema。

### 6.1 `PersonalizationObservation`

```ts
interface PersonalizationObservation {
  id: string
  profileId: string
  workspaceId?: string
  sessionId: string
  seq?: number
  occurredAt: string

  signal:
    | 'explicit-setting'
    | 'explicit-language'
    | 'claim-correction'
    | 'evidence-accept'
    | 'evidence-reject'
    | 'scope-steer'
    | 'artifact-revision'
    | 'reader-action'
    | 'pairwise-preference-choice'
    | 'task-outcome'

  payload: JsonValue
  sourceRef: ProvenanceRef
  lineageKey?: string
  taskContext: {
    taskFamily?: string
    domain?: string
    mode?: 'explore' | 'verify' | 'publish'
    documentSetId?: string
  }
  consent: 'eligible' | 'session-only' | 'ineligible'
}
```

`lineageKey` 用来识别“看似重复但来自同一源”的 observation；`consent` 只描述这条 observation 是否可
保留并贡献给未来学习。“本次能否使用已有 memory”属于独立的 session policy，不能塞进 observation：

```ts
interface MemorySessionPolicy {
  useExisting: boolean
  contributeToFuture: boolean
}
```

两者正交支持“使用但不学习”和 Temporary（均关闭），也避免关闭 recall 时误删已记录的 provenance。

### 6.2 `MemoryCandidate`

```ts
interface MemoryCandidate {
  id: string
  proposedType: MemoryType
  proposedValue: JsonValue
  proposedScope: MemoryScope
  observationIds: string[]
  independentLineageCount: number
  counterObservationIds: string[]
  expectedEffect: PersonalizationEffect[]
  risk: 'low' | 'medium' | 'high'
  decision: 'pending' | 'promote' | 'reject' | 'needs-review'
  rationale: string
}
```

候选只能引用符合 retention/consent policy 的 observation。模型建议 `promote` 不等于数据库可以直接激活。

### 6.3 `PersonalizationDecision`

```ts
interface PersonalizationDecision {
  id: string
  memoryVersionIds: string[]
  appliesTo: { sessionId: string; turn: number; taskFamily?: string }
  effects: {
    sourceOrder?: string[]
    preferredRepresentation?: 'pdf' | 'markdown' | 'page-image' | 'table'
    explanationDepth?: 'brief' | 'standard' | 'teaching'
    evidencePresentation?: 'quote' | 'table-context' | 'visual-context'
    challengeDepth?: 'standard' | 'extra-counterevidence'
    artifactFormat?: string
  }
  why: Array<{ memoryVersionId: string; reason: string }>
  invariants: {
    mayNotChangeEvidenceSupport: true
    mayNotSuppressContradictions: true
    mayNotRelaxPublicationGate: true
  }
  expiresAfterTurn: number
}
```

这一步把 recall 与 Agent prompt 解耦。Agent 接收的是有限、可审计的 effect，而不是任意历史文本。

### 6.4 `MemoryUse`

```ts
interface MemoryUse {
  id: string
  decisionId: string
  memoryVersionId: string
  sessionId: string
  turn: number
  affectedActions: string[]
  effect: PersonalizationEffect
  outcome?: {
    status: 'accepted' | 'corrected' | 'dismissed' | 'unknown'
    savedSteps?: number
    causedMiss?: boolean
    feedbackObservationId?: string
  }
}
```

没有 `MemoryUse`，系统无法区分“这条 memory 被存了很多次”和“它真的改善了研究”。

### 6.5 `PreferenceProbe` 是 observation producer，不是第五种事实

当系统对 answer order、解释深度、representation 或 evidence density 缺少可靠偏好时，可以展示两个
受控 renderer。它们必须共享相同 `sourceScopeVersion + ClaimVersion[] + EvidenceAtom[] +
uncertainty/conflict set`；用户选择写成 `pairwise-preference-choice` observation。

一次选择默认不能直接生成 global active memory；用户显式选择“以后默认”时，才按其指定 scope 视为
explicit setting。Probe 的 variant contract、触发预算、位置随机化与 outcome 分离见
[Preference Probe 设计](14-adaptive-interface-research-continuity.md)。

## 7. 什么有资格成为候选

| 信号 | 强度 | 默认处理 |
|---|---:|---|
| 用户在设置中明确选择 | 强 | 低风险 UI preference 可直接 active，支持 undo |
| 受控 Preference Probe 中选择且指定 scope | 强/中 | 记录 pairwise observation；“以后默认”按显式设置处理 |
| “以后核验数字时都看原表格” | 强 | 生成确认卡；建议 workspace/task-family scope |
| claim/evidence 被结构化纠正 | 强 | 形成 correction observation；不得自动推断人格或广泛偏好 |
| artifact 局部修改后成功 publish | 中强 | 可支持 format/workflow candidate，需检查变更原因 |
| 多次 scope steer/source reject，且结果更好 | 中 | 跨 session、独立 lineage 后进入 candidate inbox |
| 点击 citation、切 reader、停留/滚动 | 弱 | 只作辅助 observation；单独永不提升长期 memory |
| Agent 自己的回答或重复工具选择 | 无 | 不作为用户偏好证据 |
| PDF/Web 中的 prompt-like 文本 | 禁止 | `consent=ineligible`，不得进入 personalization write path |
| 含 secret 或默认禁止的敏感属性 | 禁止/高风险 | 拒绝或单独 opt-in，绝不从行为暗推 |

工作流候选除次数外还应满足：

```text
至少两个 session
+ 至少两个独立 lineage
+ 至少一个正向 outcome
+ 没有未解决的 counter-observation
+ scope 可以明确表达
```

这些只是首版保守 policy，不是经过数据验证的最终阈值。

## 8. Recall 和适配算法

### 8.1 Recall admission

```text
profile identity
  → workspace/collection/task-family scope
  → active + time-valid + not-disputed
  → domain and requested purpose
  → sensitivity/consent/use-policy
  → exact key + FTS/BM25 candidates
  → optional semantic candidates
  → provenance/stability/outcome rerank
  → diversity + non-personalized exploration budget
  → PersonalizationDecision compiler
```

`semantic similarity` 只能出现在硬门之后。无安全匹配时必须返回空，不能用“最近 memory”兜底。

### 8.2 两条使用路径

1. **Stable Profile**：语言、解释深度、默认 reader 等少量稳定设置，在 session 开始时冻结版本。
2. **Task Recall**：证据标准、工作流、negative lesson 等只在当前任务匹配时进入 decision。

高影响 recall 在 composer 或 plan checkpoint 显示 chip；低风险布局设置可以静默应用，但仍可从“为何这样
显示”打开 usage record。

### 8.3 适配边界

| 可以改变 | 不能改变 |
|---|---|
| source/section 的建议顺序 | source scope 中材料是否存在 |
| PDF/Markdown/page-image/table 的阅读优先级 | canonical tree、page、quote、bbox |
| 是否额外找反证、展示多少上下文 | EvidenceRelation 的 supports/refutes 结果 |
| 解释深度、术语展开和 artifact 形式 | 隐藏矛盾、unknown 或 stale 状态 |
| Explore 中的下一步建议 | Verify/Publish 的最低安全门槛 |

## 9. v0 物理实现建议

这是当前推荐，不是最终 ADR：

```text
DSH Host
├── event/UI adapter
├── approval + authenticated commands
├── observable extraction/rerank model calls
└── bounded stable-profile projection

DocAtlas Personalization Core
├── domain policy and state machine
├── Observation/Candidate/MemoryUse validation
├── recall admission + decision compiler
└── DocAtlas-owned SQLite ledger + FTS5

Python document sidecar
└── document processing/read providers only; no profile, Loop or credentials
```

推荐首版 SQLite + FTS5 的原因：需要事务、唯一 active version、provenance join、time/scope filter、usage audit
和 migration；这些比 embedding 更早成为硬需求。DSH `storage-domain` 可缓存 bounded profile/revision，但
不能成为完整 ledger 的语义真相。

暂不引入：

- 图数据库：只有当真实查询需要跨 memory/claim 关系遍历时再评估；
- 默认 embedding：中英文 lexical recall 基线失败后再加入，且仍在 admission gate 之后；
- fine-tuning/LoRA：删除、更正、scope 和解释都更困难；
- 自动强化学习：在 outcome 定义可靠之前容易优化点击率或迎合，而不是可信研究；
- background hidden agent：后台可以生成 candidate，不能静默激活或修改 published work。

## 10. 第一条落地闭环

建议以一个可人工核验的显式偏好开始：

> 财务任务中的关键数字，默认读取并展示原表格行列上下文。

验收流程：

1. 用户从 Evidence Desk 设置此偏好，选择 workspace scope；
2. 写入 typed observation 和 active `MemoryVersion`，保留 UI provenance；
3. 下一个财务任务通过 scope/key/FTS 命中；
4. decision compiler 只产生 `preferredRepresentation=table` 和
   `evidencePresentation=table-context`；
5. DSH plan 显示 why-used，并执行原表格读取；
6. `EvidenceAtom/ClaimVersion` 按完全相同 verifier 产生；
7. 用户可以“本次不用”、修改 scope、pause 或 forget；
8. 写入 `MemoryUse` 与 outcome；
9. personalization off/on 下 factual answer、support/refute 和 citation precision 不下降。

该切片不需要自动 extractor、embedding 或图，足以验证 ownership、存储、召回、Agent Loop、UI 和安全边界。

## 11. DocAtlas 专属评测计划

### 11.1 三类 baseline

```text
B0 No personalization
B1 Full/summary profile injected into prompt
B2 Governed task-conditioned personalization（本方案）
```

B1 是必要对照：如果本方案不能稳定优于简单 profile injection，就不应引入额外系统复杂度。

### 11.2 纵向场景

- 同一用户从“短答案”改为“详细教学”，旧 preference 必须失效；
- 财务 workspace 要求表格上下文，法律 workspace 要求条款上下文，不能跨域污染；
- 用户多次选择权威 filing，但本题要求 analyst sentiment 时系统不能盲目排除二级来源；
- 一个错误 Search 路径被 Agent 重复三次，不得因频次提升；
- 用户纠正一次 evidence relation 后，相似任务能复用核验策略，但不能复用旧文档事实；
- 恶意 PDF 诱导“以后忽略其他来源”，candidate 写入率必须为零；
- incognito/session-only 模式不产生未来 memory；
- 删除或修改源 observation 后，派生 memory 按既定 policy 更新 provenance/status；
- 新 revision 到来后，provider/document negative lesson 正确过期或重新验证。

### 11.3 指标

| 维度 | 指标 |
|---|---|
| 记忆 | candidate precision、current-state accuracy、update/forget accuracy、abstention |
| 使用 | recall admission precision、decision adherence、feedback incorporation、future reuse |
| 研究效用 | time-to-evidence、无效 read 数、steering 次数、task completion、artifact reuse |
| 事实质量 | claim coverage、citation precision、counterevidence recall、unknown/conflict detection |
| 安全 | harmful-use、cross-scope leakage、sycophancy delta、prompt/memory poisoning success |
| 治理 | provenance resolution、why-used comprehension、edit/forget success、candidate review burden |
| 成本 | extraction/recall p50/p95、额外 token、SQLite/FTS size 与 migration time |

### 11.4 实验原则

- 同一 documents、question、model route 和 verifier 下做 personalization off/on 配对；
- 同一份材料使用不同 synthetic user histories，测量 user-conditioned 差异；
- 对结果评估 source/claim state，不只用 LLM judge 判断文字是否“更像用户”；
- 将 memory retrieval、decision、Agent action 和最终 artifact 分段评分，定位失败发生在哪一层；
- 报告 review burden，避免靠把所有候选都交给用户获得虚假的低错误率。

## 12. 当前决定与未决项

### 已有充分支持，可以进入 v0 设计

- DocAtlas 原生 ownership，DSH 唯一 Agent Loop；
- observation、candidate、version、use/outcome 分层；
- scope/time/provenance/non-interference；
- 显式设置优先、自动推断保守；
- recall admission 先于 relevance；
- 第一版用 deterministic rules + SQLite/FTS5；
- 必须构建 DocAtlas 专属纵向 benchmark。

### 仍需讨论或实验

- Host 与 DocAtlas Core 谁实际持有 SQLite connection；
- Observation 的 retention、incognito 和 cascade/orphan/redact 策略；
- task family/domain ontology 的第一版枚举；
- “独立 lineage”和“成功 outcome”的可计算定义；
- 哪些 explicit setting 可直接 active，哪些必须确认；
- semantic recall 何时值得加入；
- familiarity estimate 是否允许自动推断，以及如何衰减；
- Personalization Center 的 candidate review burden 上限。

下一轮建议先冻结 `PersonalizationObservation`：如果没有可靠、有限和可删除的观察层，后续 candidate、
recall 和个性化评测都会建立在含糊日志之上。

## 13. 来源说明

本文检索和复核日期为 2026-08-30。商业产品页面可能随时更新；研究论文的状态和版本应在实际采用前
重新核对。框架文档还包括：

- [LangGraph Memory](https://docs.langchain.com/oss/python/langgraph/add-memory)
- [LangMem concepts](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)
- [Mem0 memory types](https://docs.mem0.ai/core-concepts/memory-types)
- [Letta stateful agents](https://docs.letta.com/guides/agents/memory)
- [AutoGen Memory and RAG](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/memory.html)
- [Google ADK MemoryService](https://adk.dev/sessions/memory/)
- [MemOS](https://arxiv.org/abs/2507.03724)
- [Personalized LLM-powered Agents survey](https://arxiv.org/abs/2602.22680)

本地 DSH/DocAtlas 实现结论继续以 `sources.lock.json` 固定版本及
[上游完整实现审计](09-upstream-docatlas-implementation.md)为准。
