# DocAtlas Memory 架构：自适应理解与跨文档研究连续性

> 状态：Discussion draft / product and contract input，不是已实现规格
> 日期：2026-08-30
> 关联文档：[个性化长期记忆](03-personalization-memory.md)、[文档理解页面](04-document-experience.md)、
> [Fact Trace](07-fact-trace-agent-interaction.md)、[产品路线 v2](08-product-route-v2.md)、
> [个性化实现研究](11-personalization-implementation-research.md)、
> [Note/Review/Memory 设计空间](15-note-review-memory-design-space.md)、
> [完整实施主计划](../docs/implementation-plan.md)
> 核心判断：Memory 是 DocAtlas 的上位基础能力，不等于个性化。它既要保存“用户通常怎样工作”的
> Personalization Memory，也要保存“用户已经完成过哪些有证据链的工作”的 Research Memory；两者在
> 严格类型和来源边界下共同改善下一次文档研究。

## 1. 结论先行

不能把所有跨会话状态都归到 Personalization Kernel。建议先定义统一的 DocAtlas Memory Architecture：

```text
DocAtlas Memory Architecture
  ├─ Episodic Memory          DSH messages/tool trajectory；发生过什么
  ├─ Working Memory           当前 investigation 的 plan/coverage/cursor；正在做什么
  ├─ Research Memory          Evidence-linked Claim/Note/Question/Decision；已经研究过什么
  └─ Personalization Memory   preference/familiarity/workflow；用户通常怎样研究
```

其中 Episodic Memory 的权威载体是 DSH Session Log；Working Memory 由 Session 与 Investigation Journal
投影；Research Memory 属于 DocAtlas Evidence/Claim/Investigation Core；只有 Personalization Memory 属于
Personalization Kernel。它们不是同一张自由文本 memory 表。

面向用户的累积式文档智能建立在这些 memory domain 与 Evidence Core 之上：

```text
Cumulative Document Intelligence
  = Evidence Core                     保证事实回到原文
  + Research Continuity               复用以前已完成的有证据研究
  + Adaptive Evidence Interface       学会同一事实怎样最适合用户理解、核验和决策
  + Epistemic Workflow Learning       学会用户在不同任务中怎样寻找、挑战和确认事实
```

它们分别回答：

- **Adaptive Interface**：同样的 Claim/Evidence，怎样排序、展开和呈现？
- **Research Memory / Continuity**：这次问题与以前哪些文档、Note、Claim、Decision 或 Open Question 有关？
- **Workflow Learning**：这类任务通常应先查哪里、何时看原表、何时找反例、何时进入 Verify？

关闭个性化后，Research Memory 仍应工作；选择“只根据当前文件回答”后，Personalization Memory 仍可
控制语言和排版，但 Research Continuity 不得扩大 source scope。两个能力需要正交开关、独立 API 和独立
评测。

它们不能合并成一段“用户画像”。界面偏好不是事实，旧 Note 不是原始证据，成功工作流也不能降低
verification gate。DocAtlas 的价值在于让不同 memory domain 协作，同时始终能回到 document revision
和具体原文。

Note、Review 和 Memory 也不必一一映射为“写 Memory / 读 Memory / Memory store”。Note 是捕获入口，
Review 是核验与裁决过程，Memory 是跨时间基础设施；它们单独、两两或共同工作的方案见
[正交能力与组合设计](15-note-review-memory-design-space.md)。

一句话本质：

> **DocAtlas 保存用户已经完成的证据工作，也可以学习用户如何理解证据；它不学习用户希望事实变成
> 什么。**

## 2. 为用户带来的根本价值

普通文档问答每次都近似从零开始：用户重新解释背景、重新指出关键文档、重新找到旧表格、重新说明
证据标准。即使模型回答流畅，这些重复劳动仍由用户承担。

长期价值不应只用“回答满意度”衡量，而应表达为：

```text
用户价值
  = 更少的重复说明
  + 更少的证据定位和上下文切换
  + 更少的重复核验
  + 更早发现跨文档变化、矛盾和遗漏
  + 更多可继续使用的可信研究资产
```

对应五个体验变化：

1. **从重新提问到继续调查**：新会话可以接上旧问题、旧证据与未完成事项，而不是依赖用户回忆聊天记录。
2. **从一次性答案到累积资产**：被核验的 Evidence/Claim/Comparison 可进入后续 brief、matrix 和问答。
3. **从找到相关段落到发现变化**：新文档到来时，系统知道哪些旧结论可能受影响，主动提出复核。
4. **从通用输出到个人认知界面**：同一事实按用户最容易核验的密度、顺序和 representation 呈现。
5. **从隐形画像到可检查协作**：用户能看到为什么召回旧研究、为什么采用某种呈现，以及如何纠正。

真正的复利不是“系统保存了更多聊天”，而是每处理一份文档，下一份相关文档都更容易读懂、比较和
验证。

## 3. Preference Probe：用受控对比主动校准

### 3.1 为什么它比被动猜测更可靠

偶尔给用户两个只有一个变量不同的版本，让用户选择更合适的一个，是一种透明的 preference
elicitation。它产生的信号比 scroll、停留时间或模型从语气中猜测更明确，也允许用户选择“都可以”或
“都不喜欢”。

但不能让模型独立生成两份答案。两个独立 generation 会同时改变事实、措辞、论证和 citation，用户的
选择无法归因到某个变量。正确的数据流是：

```text
Canonical AnswerSpec
  ├─ fixed ClaimVersion set
  ├─ fixed EvidenceAtom set
  ├─ fixed uncertainty/conflict disclosure
  └─ fixed source scope
            │
            ├─ Renderer A: conclusion-first
            └─ Renderer B: evidence-first
                         │
                    user choice
                         │
              PreferenceChoiceObservation
```

生成前后要验证 invariant set；如果 variant 丢失 claim、citation、unknown 或 contradiction，这次 probe
无效，不能展示也不能学习。

### 3.2 适合和不适合实验的变量

| 可以早期测试 | 必须保持不变 |
|---|---|
| 简洁摘要 / 教学式解释 | 事实结论与数值 |
| 结论优先 / 证据优先 | Claim/Evidence 对应关系 |
| 段落 / 表格 / comparison card | citation completeness 与 selector validity |
| quote 折叠 / 展开上下文 | unknown、conflict 和 counterevidence disclosure |
| 专业术语 / 主动解释术语 | epistemic status 与 confidence 语义 |
| PDF 原页优先 / Markdown 优先 | verification 与 publication gate |
| 单一推荐视图 / 多方案比较视图 | source scope 和权限边界 |

source ranking、challenge depth 和 reading plan 会影响信息发现，不是纯 renderer 变量；它们只能在后期
受控实验中测试，并始终保留 canonical/non-personalized exploration budget。

### 3.3 触发而不是随机打断

“不定时”应实现为有条件触发，而不是纯随机弹出两篇长回答：

- 新 profile 或第一次进入某个 task family；
- 当前偏好置信度低，且两个方案的 expected value 接近；
- 用户连续要求改写、展开 source 或切换 representation；
- 新行为与 active preference 冲突，可能发生 preference drift；
- 一个长期偏好超过复核期限；
- 用户主动点击“比较另一种呈现”。

初始产品预算建议为每个 investigation 最多出现一次自动 probe，只在低风险回答完成后出现；用户可以
全局关闭、延后或只保留主动触发。系统不因“没有选择”推断偏好。

### 3.4 最小交互

```text
哪一种更适合你？

[A 结论优先]  [B 证据优先]  [都可以]  [都不适合]

应用范围： [仅本次] [这个项目] [同类任务] [以后默认]
可选原因： [更快理解] [更容易核验] [更适合交付] [自定义…]
```

左右顺序随机化，但保存稳定的 variant key，避免位置偏差。选择只产生 observation：单次选择默认不应
自动成为 global memory；“以后默认”属于显式设置，可以按用户选择的 scope 直接 active。

### 3.5 Contract 草案

```ts
interface PreferenceProbe {
  id: string
  profileId: string
  sessionId: string
  turn: number
  taskContext: {
    workspaceId?: string
    taskFamily?: string
    domain?: string
    mode?: 'explore' | 'verify' | 'publish'
  }

  axis:
    | 'answer-order'
    | 'explanation-depth'
    | 'representation'
    | 'evidence-density'
    | 'terminology-depth'
    | 'comparison-layout'
  invariant: {
    sourceScopeVersion: string
    claimVersionIds: string[]
    evidenceAtomIds: string[]
    semanticHash: string
  }
  variants: Array<{
    key: string
    effect: JsonValue
    artifactId: string
    invariantCheck: 'passed' | 'failed'
  }>
  presentationOrder: string[]
  generatedAt: string
}

interface PreferenceChoiceObservation {
  probeId: string
  selected: string | 'both' | 'neither' | 'dismissed'
  scopeIntent: 'turn' | 'workspace' | 'task-family' | 'global'
  reasonTags?: string[]
  occurredAt: string
}
```

`semanticHash` 不能单独证明语义等价；它只是审计辅助。正式 gate 应检查相同的 claim/evidence/uncertainty
引用集合，并对 renderer 做 fixture 和 mutation tests。

### 3.6 “喜欢”与“有帮助”必须分开

用户选择只证明主观 preference，不证明任务效果。系统还要独立观察：

- 是否更快打开正确 evidence；
- 是否减少“展开上下文”“给出处”等重复 steering；
- 是否减少后续事实纠正；
- 是否提高 claim review 完成率；
- 是否改善 artifact reuse；
- 是否增加阅读负担或隐藏必要信息。

因此 `PreferenceChoiceObservation` 与 `MemoryUse.outcome` 不能合并。用户有权选择自己喜欢的界面，产品
也必须诚实报告它是否真的改善理解和核验。

## 4. 更本质的 Memory：Research Memory 与 Continuity

### 4.1 为什么它比“回答风格”更深

表达个性化解决“这次怎样讲”。Research Memory 解决“以前已经完成了什么”，Research Continuity 负责
把这些资产安全带入本次 investigation。它是通用 DocAtlas Core 能力，不隶属于 Personalization Kernel。
对年报、合同、论文、规范、审计材料和持续尽调而言，用户真正昂贵的资产通常不是聊天文本，而是：

- 已定位并核验的原文；
- 已拆分的 Claim 及其 support/refute 关系；
- 已处理或仍未解决的矛盾；
- 用户明确作出的 project decision 和 assumption；
- 跨版本比较结果；
- 尚待补充的 source、问题和验证步骤；
- 被证明有效或失败的研究路径。

新问题与这些资产相关时，系统应能找到它们；但找到旧内容只是 lead，不等于它在当前 source scope、
版本和时间下仍然成立。

### 4.2 四个状态域

现有三域模型可进一步细分，避免把跨文档知识塞进 Personal Memory：

| 状态域 | 回答的问题 | 典型对象 | 权威性与使用规则 |
|---|---|---|---|
| Source World | 原始材料具体说了什么？ | DocumentRevision、Representation、EvidenceAtom | 绑定 revision + locator；事实证明的根 |
| Research World / Research Memory | 过去已经提出、核验、比较或决定了什么？ | ClaimVersion、ResearchNote、Decision、OpenQuestion、Artifact | derived；复用前检查来源、scope、status 和 freshness |
| Task World | 这次调查正在做什么？ | goal、plan、coverage、cursor、budget | 由 DSH Session + Investigation projection 重建 |
| Personal World | 这个用户通常怎样研究和理解？ | preference、familiarity、workflow、negative lesson | 只能改变策略/界面，不能成为 factual support |

Research World 是“跨 investigation 的研究记忆”，Continuity 是它在新任务中的召回与复核机制；
Personal World 是“跨 investigation 的用户适配”。它们可以互相提供 query signal，但不能互相充当
evidence，也不因关闭其中一个而连带关闭另一个。

### 4.3 Note 应从自由文本容器变成类型化入口

现有 Note 的本质价值是让人或 Agent 留下 checkpoint；问题在于自由 `source: "Page N"` 同时混合事实、
解释、计划与偏好。未来 UI 仍可叫 Note，但写入时应落到不同领域对象：

| 用户动作/内容 | 应写入 | 后续可怎样使用 |
|---|---|---|
| 保存一段原文 | EvidenceAtom / EvidenceBookmark | 精确回原页；不能自动声明含义 |
| “这段支持收入增长 12%” | ClaimVersion + support relation | re-resolve 后进入回答或 comparison |
| “这个结论与附录不一致” | Claim challenge / conflict link | 进入 Contradiction Inbox |
| “还需找到审计口径” | OpenQuestion | 后续 investigation 可继续 |
| “本项目统一采用物理页码” | Project Decision / ResearchPolicy | 在 scope 内确定性执行，不是个人偏好 |
| 用户自己的综合判断 | ResearchNote + claim/evidence refs | 作为 commentary；事实 span 仍需引用 Claim |
| “以后先看原表” | Personalization observation/candidate | 影响未来计划，不证明当前数字 |

不要建立一个包办所有语义的 `NoteRecord`。ResearchNote 只保存用户/模型的 commentary 与对象引用；
Evidence、Claim、Decision、Question 和 Personal Memory 仍有独立 schema、生命周期和权限。

最低限度的 ResearchNote 可以是：

```ts
interface ResearchNote {
  id: string
  workspaceId: string
  investigationId: string
  title?: string
  body: string
  author: { kind: 'user' | 'agent'; actorId: string }
  claimVersionIds: string[]
  evidenceAtomIds: string[]
  decisionIds: string[]
  openQuestionIds: string[]
  provenanceActivityId: string
  epistemicLabel: 'commentary' | 'synthesis' | 'unverified'
  createdAt: string
  supersededById?: string
}
```

一个没有可解析 refs 的 legacy factual Note 只能导入为 `unverified` lead；不能因为以前保存过就升级为
EvidenceAtom 或 accepted Claim。

## 5. Research Memory 的跨文档召回必须采用 recall-to-reverify

### 5.1 推荐流程

```text
Current question + explicit source scope
                    │
                    ├─ Search/Read current documents
                    │
                    └─ Query Research World
                              │
                     bounded ResearchRecallLead
                 prior claim/note/question/decision/artifact
                              │
                scope + freshness + provenance check
                              │
             if outside current scope: ask user to include source
                              │
             re-resolve prior EvidenceAtom locators/revisions
                              │
          compare current evidence with reverified prior evidence
                              │
         answer labels current/prior/changed/conflicted/unknown
                              │
             append new Claim/ContinuityLink/Outcome
```

召回结果只返回 bounded metadata、reason、status 和 IDs，不把旧 session、整篇 Note 或旧 PDF 文本一次性
塞进模型。真正需要的旧原文继续通过 progressive `Read(locate → blocks/expand/visual)` 精确读取。

### 5.2 `ResearchRecallLead` 不是 Evidence

```ts
interface ResearchRecallLead {
  id: string
  kind: 'prior-claim' | 'research-note' | 'open-question' | 'decision' | 'artifact'
  objectId: string
  workspaceId: string
  matchedOn: string[]
  reason: string
  sourceRevisionIds: string[]
  status: 'current' | 'stale' | 'superseded' | 'unverified' | 'missing-source'
  lastVerifiedAt?: string
  scopeChangeRequired: boolean
}
```

它只能告诉 Agent“值得回去看什么”。只有重新解析出的 EvidenceAtom，以及经当前 scope/policy 验证的
ClaimVersion，才能支持本轮 factual claim。

### 5.3 Source scope 不能被记忆静默扩大

用户问“只根据这份合同回答”时，系统可以提示存在相关旧 Note，但不能把旧合同内容偷偷混入答案。
如果需要比较，UI 应显示：

```text
发现 2 条相关旧研究：
  • 2025-02 合同草案 · Clause 7 · 已核验
  • 法务决策：通知期不得少于 30 天

[加入本次 source scope 并比较] [只查看] [本次忽略]
```

接受后创建新的 `sourceScopeVersion` 并写入 DSH trajectory；拒绝不应降低旧记录的全局 relevance，只记录
这次 task outcome。

## 6. 典型场景

### 6.1 周期性财务报告：从“回答本期”到“解释变化”

用户问：

> 这份 Q2 报告中现金流为什么下降？

系统先读 Q2 当前报告，同时发现 Q1 investigation 中有一条 Note：应收账款增长与某次收购有关。正确
行为不是直接复述旧 Note，而是：

1. 显示“找到相关 Q1 已核验 Claim”；
2. 打开 Q1 原表和 management explanation；
3. 读取 Q2 现金流表及口径说明；
4. 区分持续原因、一次性原因和已变化口径；
5. 回答中把 Q1 与 Q2 citation 分列；
6. 若旧解释已不适用，将旧 Claim 标 stale/superseded，而不是覆盖历史。

用户得到的不只是更快的问答，而是一条持续更新的经营变化时间线。

### 6.2 合同版本：记住决策，但重新核验条款

过去用户在 draft v2 留下 Decision：“终止通知不得少于 30 天”，并核验了 Clause 7。v3 到来后用户问
“这一版还有什么风险？”系统可以：

- 识别 v2 Decision 仍在当前 workspace 生效；
- 对齐 v2/v3 Clause 7，而不是按页码机械比较；
- 发现 v3 改为 15 天并生成 contested Claim；
- 显示 Decision 是项目规则、合同文字是 Document Evidence；
- 让用户接受变更、要求恢复或更新 Decision。

这里最重要的是把“我们希望怎样”与“合同现在写了什么”放在一起比较但保持类型隔离。

### 6.3 科研文献：新论文触发旧反证

用户阅读一篇支持某机制的新论文。过去的 Research World 中已有另一篇论文的实验限制和一条 unresolved
question。系统应提示相关旧研究，重新打开方法和结果原文，并帮助用户建立：

- 新论文支持的 Claim；
- 旧论文的 refuting/qualifying Evidence；
- 样本、方法、population 和时间差异；
- 仍无法回答的问题。

它避免新论文的流畅摘要覆盖用户以前辛苦找到的反证，也避免把旧结论当永恒真理。

### 6.4 审计与尽调：未解决问题自动延续

上一次 investigation 记录“缺少供应商集中度明细”，状态为 OpenQuestion。新 data room 文件加入后，
系统可以把它作为检索 lead：

- 新文件是否真的覆盖该问题？
- 使用了哪个 reporting period 和定义？
- 问题是 resolved、partially-resolved 还是仍 unknown？
- 哪些旧 brief 需要 update？

价值不是记住一句笔记，而是维护问题的生命周期和 coverage。

### 6.5 标准、规范和产品文档：影响分析

团队曾依据 API spec v1 发布实现决策；v2 修改字段语义。Research Continuity 将 revision diff 连接到旧
Decision、Claim 和 Artifact use，提示哪些代码说明、测试计划或发布文档可能失效。它把“读新文档”升级
为“知道新文档改变了过去哪些工作”。

### 6.6 用户熟悉度与历史知识并行

用户已经多次研究某公司的 revenue recognition。系统可以少解释基础术语，这是 Personal World；同时
召回过去的会计政策变更和已核验表格，这是 Research World。前者改变解释深度，后者必须重新引用来源。
两者一起让回答更高效，但 UI 要分别显示“按你的熟悉度简化解释”和“引用了 2025 年旧研究”。

## 7. 页面与交互

### 7.1 三种解释不能混成一个 Sources 列表

```text
Sources / Evidence     这个事实由哪些原文支持？
Related prior work     为什么系统想到以前的研究？
Why personalized      为什么采用这种阅读、核验或呈现方式？
```

Document citation 点击回原文；prior-work chip 打开旧 investigation/claim/note；personalization chip 打开
Personalization Center。三者的颜色、图标和计数都应不同。

### 7.2 Evidence Desk 新增的轻量界面

- **Related prior work rail**：最多显示少量高价值 lead，带 status、日期、workspace 和“为何相关”；
- **Bring into investigation**：显式扩展 source scope 或只把旧 question/decision 加入 task context；
- **Reverify**：让 DSH Agent Loop 重新解析旧 locator，再比较当前 source；
- **Changed since last time**：新 revision 影响的 Claim/Artifact/Decision 列表；
- **Preference calibration card**：回答后显示局部 A/B，而不是复制整个长回答；
- **Neither / not relevant**：拒绝信号有 scope，不永久删除原对象；
- **Continue open question**：一键把旧问题变成本轮可见 subtask。

长回答的 probe 应显示局部 diff 或两个可切换 renderer，避免让用户重新阅读两遍完全相同的事实内容。

### 7.3 Personalization Center 与 Research Notebook 分开

- **Personalization Center**：用户偏好、熟悉度、工作流、candidate、why-used、pause/forget；
- **Research Notebook / Claim Ledger**：Evidence、Claim、Note、Decision、OpenQuestion、Comparison、Artifact；
- **Activity/Trajectory**：DSH Agent 实际执行了哪些步骤。

产品设置中可以有一个 Memory 总入口，但进入后必须明确分区并能互相跳转，不能把三种 domain 混成
一个文本列表。

## 8. 与 DSH Agent Loop 和 Progressive Read 的结合

DSH 仍拥有唯一 Agent Loop。建议的可见步骤是：

```text
0 Scope       确定当前 source scope、是否允许 related prior work
1 Recall      DocAtlas 返回 bounded leads，不返回旧文档全文
2 Plan        Agent 显示准备复核哪些旧 Claim/OpenQuestion
3 Observe     用 locate → blocks/expand/visual 读取当前与旧 source
4 Reverify    检查 locator、revision、quote hash、freshness
5 Challenge   寻找当前反证、口径和时间差异
6 Synthesize  生成同一 canonical Claim/Evidence backbone
7 Render      应用 PersonalizationDecision；必要时生成 PreferenceProbe
8 Record      写入 Claim/ContinuityLink/MemoryUse/Outcome
```

需要模型参与的 prior-work rerank、candidate extraction 或 probe 文案生成，都必须作为 DSH 可观察步骤进入
trajectory，支持 cancel/steer/budget。Python document sidecar 只负责 source processing 和 locator resolve，
不能拥有另一套隐形聊天或长期用户画像。

不需要为每个动作立即增加模型可见 tool。source 内容继续统一由 `docatlas_read` 的 progressive modes 获取；
Research Continuity 可以先作为 Host/Core query + projection，在确有 Agent 自主调用需求时再冻结公开 tool
surface。

## 9. 最小新增领域对象与不变量

首轮 contract 讨论至少需要：

```text
PreferenceProbe                  受控呈现实验及 invariant backbone
PreferenceChoiceObservation      用户选择、scope intent 和原因
ResearchNote                     commentary + typed object references
ResearchRecallLead               bounded prior-work candidate，不是 evidence
ContinuityLink                   当前与过去对象为何相关
MemorySessionPolicy              use-existing / contribute-to-future
ResearchContinuityPolicy         off / suggest / auto-within-explicit-scope
ResearchPolicy                   必须遵守的 workspace/project 规则
```

关键不变量：

1. Preference variant 不得改变 Claim/Evidence/uncertainty/conflict 集合。
2. Pairwise choice 是 observation；除显式“以后默认”外不直接创建 global active memory。
3. ResearchRecallLead 永远不能成为 EvidenceRelation 的 source。
4. 旧 Note factual span 没有可解析 evidence refs 时只能标 `unverified`。
5. 跨 scope 使用旧 source 必须创建显式 `sourceScopeVersion`。
6. source revision 变化后，旧 locator 必须 re-resolve；失败时显示 stale/missing，不能模糊匹配后静默使用。
7. Personal Memory、ResearchPolicy、Project Decision 与 Document Evidence 使用不同 ID/schema/API/UI。
8. personalization off/on 不改变 support/refute、selector resolution 和 publication gate。
9. derived Note/Artifact 不得反过来作为支持自身 Claim 的独立 source。
10. 删除旧 investigation/note 后，ContinuityLink 按 cascade/orphan/redact policy 更新，不能留下伪来源。
11. personalization disabled 不得关闭 Research Memory；continuity disabled 不得清除或改写 Personal Memory。

## 10. 风险与治理

| 风险 | 约束 |
|---|---|
| Preference Probe 造成选择疲劳 | 频率预算、主动关闭、只在高信息增益时触发 |
| 两个版本不再语义等价 | canonical backbone + invariant gate + renderer fixtures |
| 用户偏好形成 filter bubble | canonical Lens、non-personalized exploration budget、可见 why-used |
| 旧 Note 被当作事实 | recall-to-reverify；unverified/stale 状态不可隐藏 |
| 新文档 prompt injection 污染长期状态 | document/tool/assistant 内容不可直接成为 personal observation |
| 旧事实过时 | revision/time/status gate，new-source impact analysis |
| 跨 workspace 泄漏 | profile/workspace/collection/task admission 在 relevance 前执行 |
| source scope 被静默扩大 | include action + scope version + trajectory audit |
| derived source 循环证明 | provenance DAG + no-self-support invariant |
| 系统为了“更像用户”迎合错误结论 | preference 只调界面/策略，事实 verifier 独立 |

## 11. 如何评测

### 11.1 Adaptive Interface

- variant invariant pass rate；
- pairwise choice consistency 和 preference drift detection；
- probe dismissal/fatigue rate；
- time-to-first-relevant-evidence；
- follow-up rewrite/expand/source requests；
- claim review completion 与 correction rate；
- personalization on/off factual non-regression。

### 11.2 Research Continuity

- prior-work lead precision/recall；
- stale/superseded/missing-source detection；
- locator re-resolution success；
- contradiction/change recall；
- open-question resolution accuracy；
- cross-scope leakage；
- old Note self-support/circular provenance success rate，目标为零；
- 与无 continuity baseline 相比减少的 Read/tool calls 和用户重复说明；
- 新 revision 到来后 impacted artifact/claim 的发现率。

### 11.3 纵向场景

同一 synthetic user 至少连续完成 5–10 个相关 investigation，混入：新 revision、矛盾 source、偏好变化、
无关旧 Note、删除 source、incognito session 和恶意文档。不能只测“能否找回一句旧话”。

## 12. 分阶段落地

### A0：冻结语义，不激活自动学习

- 明确 `EpisodicMemory != WorkingMemory != ResearchMemory != PersonalizationMemory`，并继续细分
  `ResearchPolicy != PersonalMemory != ResearchNote != Evidence`；
- 冻结 PreferenceProbe/ChoiceObservation/ResearchRecallLead contract；
- 定义 scope、deletion、incognito、reverification 和 source inclusion policy；
- legacy Note importer 一律以 `unverified` 起步。

### A1：显式界面校准

- canonical AnswerSpec 的两个 deterministic renderer；
- 只测试 answer order、explanation depth、evidence density；
- 用户选择 scope；
- why-personalized 和 reset；
- 不做自动候选提升。

### R1：同 workspace 的 research recall

- 只召回 typed Claim/OpenQuestion/Decision/Note refs；
- 返回少量 leads；
- 用户显式 bring-in；
- re-resolve 旧 Evidence；
- 记录 ContinuityLink 和 outcome。

### R2：版本与变化追踪

- 新 revision impact analysis；
- Claim stale/superseded propagation；
- Compare Lab 时间线与 contradiction inbox；
- 受影响 Artifact 提示，不自动重写。

### A2：受控习惯学习

- 多个 independent probes/steering 形成 MemoryCandidate；
- task-conditioned recall；
- reading plan 和 representation adaptation；
- MemoryUse/outcome 与非个性化探索预算。

### R3：跨 workspace/provider continuity

只有 profile identity、权限、同步、retention 和安全评测成熟后才开放。首版不做全局“搜索我所有历史”。

依赖关系：A1 可以与 Evidence contracts 并行；R1 的 factual reuse 必须等 DocumentRevision、Locator、
EvidenceAtom 和 ClaimVersion 稳定，否则旧 Note 无法可靠回到原文。

## 13. 产品表达

“生成两种风格供选择”只是可见入口，完整价值主张应是：

> **DocAtlas 不只记住你喜欢怎样看答案。它还保存你以前查过什么、哪些结论已经核验、哪些问题仍未
> 解决；当新文档到来时，它会把相关研究带回来、重新落到原文，并告诉你什么发生了变化。**

可以拆成三个用户承诺：

1. **保存你查过什么**：旧研究成为有来源、可复核、可继续的 Research Memory。
2. **懂你怎么读**：可选的 Personalization Memory 让同一证据以更合适的方式呈现。
3. **知道什么变了**：新文档主动触发旧 Claim、Decision 和 Artifact 的影响分析。

这比“AI 记住你的一切”更具体，也比“文档聊天有历史记录”更有价值。真正的 moat 是用户逐步形成的
`evidence-backed research state + governed adaptation history`，而不是不可解释的聊天摘要或向量库规模。

## 14. 当前建议决定与待讨论项

建议纳入后续 ADR/contract review：

| ID | 状态 | 建议决定 |
|---|---|---|
| ADAPT-001 | 建议确认 | Preference Probe 必须共享 canonical Claim/Evidence/uncertainty backbone |
| ADAPT-002 | 建议确认 | 单次 pairwise choice 默认只是一条 observation；显式 scope choice 可直接成为设置 |
| ADAPT-003 | 暂定 | 自动 probe 每个 investigation 最多一次，并由信息增益/漂移触发 |
| CONT-001 | 建议确认 | Research Memory 是通用 DocAtlas Core 能力，不属于 Personalization Kernel |
| CONT-002 | 建议确认 | 旧 Note/Claim recall 采用 lead → re-resolve → reverify，不直接注入为事实 |
| CONT-003 | 建议确认 | 跨 source scope 使用历史文档必须由用户或已批准 policy 显式扩展 scope |
| CONT-004 | 暂定 | Personalization Center 与 Research Notebook/Claim Ledger 分成独立产品面 |
| CONT-005 | 暂定 | R1 先支持同 workspace typed objects，跨 workspace/global history 后置 |
| CONT-006 | 建议确认 | Personalization 与 Research Continuity 使用正交开关，关闭一方不删除或禁用另一方 |

仍需讨论：

- `ResearchPolicy` 与 Project Decision 的 enforcement/继承边界；
- PreferenceProbe 的 renderer 是 Host deterministic transform，还是允许一次受约束模型 rewrite；
- 什么信息增益阈值值得打断用户；
- ResearchRecallLead 的第一版 rank 是否只用 exact key + FTS5；
- 旧 source 无权访问或已删除时，Note/Claim 的可见性与删除语义；
- 同一旧 Claim 被新文档支持、限定和反驳时如何自动建议 link 而不自动裁决；
- “用户喜欢”与“任务更有效”冲突时，产品怎样展示而不替用户做隐形选择。
