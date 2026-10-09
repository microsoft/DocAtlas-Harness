# Note、Review、Memory：正交能力与组合设计

> 状态：Discussion draft / implementation planning input，不是已实现规格
> 日期：2026-08-30
> 当前实现审计：`DocAtlas-Harness` commit `b1e983a13a4c`，分支
> `docatlas-dsh/progressive-read`；Note/Review 本身未在该分支修改
> X0 实施更新：2026-08-30 已在 downstream PostNote/Agent Loop 增加 multi-doc fail-closed、multi-Note/turn、
> failed-Note 和 current-question projection containment；本文件的限制分析仍描述 legacy 数据模型本身。
> 关联文档：[完整上游实现审计](09-upstream-docatlas-implementation.md)、
> [Fact Trace](07-fact-trace-agent-interaction.md)、
> [DocAtlas Memory 架构](14-adaptive-interface-research-continuity.md)、
> [完整实施主计划](../docs/implementation-plan.md)

## 1. 结论先行

不应先规定“Note 和 Review 就是 Memory 的两个工具”，也不应因为现有代码有这两个 tool，就把未来
领域模型压进它们。更稳妥的第一性定义是：

```text
Note    回答：什么值得被人或 Agent 外化、标注、解释或留待继续？
Review  回答：什么需要重新检查、比较、挑战、裁决或签核？
Memory  回答：什么应该跨时间保留，在什么 scope 和条件下重新出现？
Tree    回答：当前 source 中去哪里找，以及哪些派生线索值得辅助导航？
```

它们分别是：

- **Note：捕获与表达能力**，核心是低摩擦地保存人的意图、观察、问题和解释；
- **Review：质量与决策过程**，核心是发现缺口、验证关系、处理冲突并产生可审计决定；
- **Memory：跨时间基础设施**，核心是持久化、索引、召回、版本、scope、遗忘和 outcome；
- **Tree/Overlay：导航投影**，核心是把结构和派生线索投射到阅读路径，不拥有事实真相。

三者可以独立使用，也可以两两组合。只有长期、多文档、高价值研究才需要三者全部参与。一个简单的
单页问答不应被强迫写 Note、做 Review 或形成长期 Memory。

最简结论：

> **保留 Note、Review、Memory 各自最强的用户价值；先设计领域对象和工作流，再决定哪些动作需要成为
> Agent tool。**

## 2. 当前 Note/Review/Tree 的真实能力

### 2.1 当前链路

```text
Read result
    │
    ▼
Note(found, plan, evidence[{type, source, content}])
    │
    ├─ append 到当前 session.json
    ├─ PostNote archive：压缩此前 Read result
    └─ Tree annotation：把 evidence 摘要写入 session tree.page_findings

Review(query)
    │
    ├─ 读取当前 session 的 analysis notes
    ├─ 取最近 100 条，构建 id/page/source/found cards
    ├─ 内部辅助 LLM 选 note IDs
    └─ 返回选中 Note 的 rendered preview
```

### 2.2 值得保留的优点

| 当前能力 | 真实优点 |
|---|---|
| Note 的 `found/plan/evidence` | 比无结构聊天摘要更接近 investigation checkpoint |
| append-only timeline | 保留发生顺序，便于当前 session 回看 |
| session 文件原子替换 | 单进程顺序调用下不易产生半写 JSON |
| Review 先 card 后全文 | 已意识到不应把全部历史无条件塞回 context |
| Review 只让辅助模型返回 IDs | 比让模型自由改写 Note 更容易约束 |
| PostNote archive | 在 legacy full-page Read 下能显著缩小上下文 |
| session-local `page_findings` | 能让后续 Search 利用先前阅读，不直接改磁盘 canonical tree |
| Search prompt 标记 partial hints | 明确提醒 finding 不是完整页面或排除性证据 |

这些优点说明现有实现是一个有价值的 **Working Memory prototype**，不应简单删除。

### 2.3 本地探针确认的限制

本轮使用无外部模型的本地探针确认：

- factual `found` 没有 evidence 仍可保存；
- `source="not a locator"` 且 evidence content 为空仍可保存；
- `source="Page 999"` 仍可保存；
- evidence-only Note 的正文不进入 Review candidate card；
- 101 条 Note 中，最早一条不会进入 Review 的最近 100 条候选，且没有 cursor；
- 长 evidence 虽完整存进 JSON，Review 使用的 renderer 只返回约 200 字符 preview；
- 多文档中，本应属于 B/p.2 的 finding 被写进 A/p.2；
- 同一 model turn 写两条 Note 时，Tree hook 只处理最后一条；
- Tree observation 的 query 变成笼统的 `the previous search`，当前 question 没有真正绑定。

现有针对性测试 `15 passed`，但主要覆盖 Review 输出 ID parser、PostNote 开关和基础 session 行为，没有
覆盖上述长期 Memory、multi-doc identity、召回完整性和 retract/revision invariants。

### 2.4 当前能力的准确定位

| 用途 | 当前判断 |
|---|---|
| 同一 live session 内保存阅读 checkpoint | 可用原型 |
| legacy Read tool result 的上下文压缩 | 有用但 archive 范围过宽 |
| 同一 session 内按自然语言找部分 Note | 可用但 recall 不完整、无预算 |
| 跨 TUI restart、`/clear`、新 workspace | 没有正常召回路径 |
| 多文档可靠 Evidence/Claim memory | 不可用，存在已复现 identity 错写 |
| Personalization Memory | 不支持，也不应直接复用 factual Note |
| 长期 Research Memory | 只有原始材料，不具备 lifecycle 和 reverify |

配置中的 `memory=true` 当前实际表示 post-Note context archival，不表示长期 Memory。后续应重命名为
`context_archival` 或交由 DSH context management，避免产品和配置语义误导。

## 3. 三项能力的独立优势

### 3.1 Note：捕获人类意图和局部理解

文档阅读中最难自动推断的内容常常不是原文，而是“为什么这段对我重要”：

- 用户把某段标为关键，不等于它在通用 relevance ranking 中最高；
- 用户可能写下假设、疑问或反例线索，它们尚不应成为 Claim；
- 一次谈判决定、审阅意见或研究直觉可能没有 document evidence，但仍值得保存；
- 用户可能只想在页边写一句评论，并不希望它进入长期画像或最终报告。

因此 Note 的核心优势是 **deliberate externalization**：让人把暂时无法或不适合结构化的思考从脑中移到
工作空间，并保留与原文的空间关系。

Note 不需要全部有 Evidence，但必须有 epistemic type：

| Note 类型 | 是否要求 Evidence | 默认含义 |
|---|---:|---|
| `bookmark` | locator 即可 | 稍后回来，不作事实判断 |
| `commentary` | 可选 | 用户/Agent 对原文的解释 |
| `hypothesis` | 否 | 待验证猜想，不能进入 supported answer |
| `open-question` | 否 | 尚未解决的问题或资料缺口 |
| `claim-proposal` | 是 | 建议创建 Claim；必须绑定 EvidenceAtom |
| `conflict-flag` | 至少一个 ref | 怀疑存在矛盾，等待 Challenge/Review |
| `decision-draft` | 可选 | 用户/项目准备采用的决定，不是 document fact |
| `scratch` | 否 | session-only，不进入 Research Memory |

关键不是“无 evidence 就拒绝 Note”，而是“无 evidence 的 Note 不能伪装成已支持 Claim”。

### 3.2 Review：把材料转成可接受、可纠正的判断

当前 Review 只是 recall，但“Review”在真实工作中的价值更大：

- 检查答案中的每个 factual span 是否有支持；
- 比较两个合同版本并识别 materially changed clauses；
- 挑战一个 Claim，寻找反证、口径差异和遗漏范围；
- 审查一批 Notes，合并重复项、标记过时项和未验证项；
- 检查 Research Memory 中的旧结论是否仍适用于新 revision；
- 在 Publish 前执行 checklist、policy gate 和 human sign-off；
- 对用户修订后的 artifact 判断是“只改表达”还是“改变事实”。

Review 的本质不是找回历史，而是 **quality transformation**：输入可以混乱、不完整、有冲突；输出必须
明确 issues、coverage、decision、actor、time 和后续动作。

Review 可以完全不依赖 Note。例如第一次收到一份合同时，用户可直接发起 four-corners Review；也可以
完全不依赖长期 Memory，只对当前 source scope 做一次性检查。

### 3.3 Memory：让不同时间的工作连续，但不替代工作本身

Memory 的独立价值是：

- 保存 episode、task、research 和 personalization 的适当状态；
- 在正确 profile/workspace/task/source scope 中召回；
- 知道一个对象 current、stale、superseded、resolved 还是 deleted；
- 将旧 source/claim 带回新调查时执行 re-resolve/reverify；
- 记录为什么使用、产生了什么影响、后来是否被纠正；
- 支持“只用不学”“只在本次使用”“不召回旧研究”等正交控制。

Memory 可以没有显式 Note。例如：DSH Session Log 是 Episodic Memory；用户固定的界面设置可以直接成为
显式 preference；Review 产生的 accepted Claim 可以进入 Research Memory，即使用户从未点击“写 Note”。

### 3.4 Tree/Overlay：把记忆投射成阅读路径

Tree update 的独立优势是 **spatial and structural recall**。相比在 chat 中返回一串历史文本，它能在用户
浏览 source 时提示：

- 这一节以前产生过 accepted Claim；
- 这一页有 unresolved question；
- 新 revision 可能影响一份已发布 brief；
- Agent 已读过但 coverage 不完整；
- 某个 personalized Lens 为什么把该 section 提前。

这种“在原文结构上重新遇见过去工作”的体验非常适合文档理解。但它只能是 projection，不能成为
Memory source of truth。

## 4. 单独、两两和三者组合

| 组合 | 主要价值 | 现实例子 | 主要风险 |
|---|---|---|---|
| Note only | 局部标注、思考外化 | 阅读论文时写页边假设 | Note clutter、事实/评论混淆 |
| Review only | 一次性质量检查 | 首次审一份合同、核对一份报告 | 无法继承历史决定 |
| Memory only | 自动连续性、设置恢复 | 恢复上次页码、语言、session history | 被动历史缺少用户意图 |
| Note + Review | 当前 investigation 的捕获与整理 | 深读一份报告后整理发现和缺口 | Review 若只总结会放大错误 Note |
| Note + Memory | 跨时间个人/团队 notebook | 长期文献批注、案件 matter notes | 旧 Note 过时或跨 scope 泄漏 |
| Review + Memory | 周期性复核和影响分析 | 每季度复核旧 Claim、刷新风险 | 旧结论形成路径依赖 |
| Note + Review + Memory | 累积式专业研究 | 尽调、诉讼、审计、持续财务研究 | 架构和用户治理复杂 |
| 任意组合 + Tree Overlay | 在原文结构中导航到相关状态 | 打开新版 PDF 即看到受影响章节 | overlay 污染 canonical structure |

这张表带来两个设计原则：

1. 产品不应把“写 Note”作为每个回答的必经步骤；
2. Memory 不应只索引 Note，它还应索引 Claim、Question、Decision、Artifact、ReviewOutcome 和 Session。

## 5. Note 的后续优化

### 5.1 Capture first，按需结构化

写 Note 时不应让用户填写复杂表单。Evidence Desk 已知道 current document、revision、page、selection、
Agent cursor 和 investigation，可以自动附加 context：

```text
用户选区 → [保存摘录] [写评论] [提出问题] [形成主张] [标记冲突]
```

- 保存摘录：创建 EvidenceBookmark/EvidenceAtom；
- 写评论：创建 commentary Note；
- 提出问题：创建 OpenQuestion；
- 形成主张：进入 Claim editor，选择 support/refute/qualify；
- 标记冲突：创建 challenge，等待 Review。

用户仍然感觉是在“记笔记”，底层不必把所有动作写成同一种 Note JSON。

### 5.2 Note 自身的最小字段

```ts
interface ResearchNote {
  id: string
  version: number
  author: { kind: 'user' | 'agent'; actorId: string }
  scope: {
    workspaceId: string
    investigationId?: string
    visibility: 'session' | 'workspace' | 'private-profile'
  }
  kind: 'bookmark' | 'commentary' | 'hypothesis' | 'scratch'
  body: string
  locatorIds: string[]
  evidenceAtomIds: string[]
  claimVersionIds: string[]
  openQuestionIds: string[]
  status: 'active' | 'resolved' | 'superseded' | 'archived' | 'deleted'
  createdAt: string
  supersededById?: string
}
```

`claim-proposal`、Decision 和 OpenQuestion 可以从 Note UI 创建，但应持久化为自己的 domain object，不必
继续塞在 `ResearchNote.kind` 中。

### 5.3 User Note 与 Agent Note

- User Note 表达人的意图和判断，不能被 Agent 静默改写；
- Agent Note 是 checkpoint/suggestion，默认标 `agent-generated`；
- Agent 可以建议把 Note 转成 Claim/OpenQuestion，但需要 policy 或用户确认；
- 编辑创建新 version，旧 artifact 仍能解析原 Note；
- user commentary 可以被引用为“用户备注”，不能伪装成 document evidence。

### 5.4 防止 Note clutter

- 自动检测 exact duplicate，但不自动合并语义不同的 Note；
- 提供 inbox：unanchored、unverified、stale、resolved；
- 支持按 source/claim/question/project 聚合，而不是只按创建时间列出；
- session scratch 到期自动归档，但不自动删除用户 Note；
- Review 可以提出 merge/supersede 建议，真正修改由可审计 command 完成；
- 显示哪些 Note 从未再次使用，帮助用户清理而不是偷偷降权消失。

## 6. Review 的后续优化

### 6.1 先把 Recall 从 Review 中拆清楚

当前 `Review(query)` 实际执行 note retrieval。未来应至少在语义上分开：

```text
Recall  找到可能相关的旧对象，返回 bounded leads
Review  检查对象及其关系，产生 issues/decision/outcome
```

兼容期可以保留旧 Review alias，但产品文案和新 contract 不应继续把“找回来”称为“审查完成”。

### 6.2 Review modes

| Review mode | 输入 | 输出 |
|---|---|---|
| `answer-coverage` | AnswerSpec + Claim uses | unsupported/missing/overclaimed spans |
| `claim-challenge` | ClaimVersion + source scope | supporting/refuting/qualifying evidence、unknown |
| `document-diff` | 两个 revision/section | added/removed/changed/ambiguous claims |
| `note-hygiene` | Note set | duplicate/stale/unanchored/convert suggestions |
| `memory-refresh` | ResearchRecallLead + new sources | current/stale/superseded/unresolved proposal |
| `policy-check` | ResearchPolicy + artifact | violations、waivers、required actions |
| `publish-gate` | ArtifactManifest | pass/fail、issues、human sign-off requirement |

### 6.3 三层 Review，而不是一个 LLM 总结

```text
Deterministic checks
  locator/hash/schema/scope/citation coverage/calculation
                │
                ▼
DSH Agent challenge
  搜 supporting/refuting evidence、解释差异、提出 patch
                │
                ▼
Human review
  accept/edit/reject/waive/sign-off
```

每层结果都结构化，后层不能抹掉前层失败。模型调用由 DSH 执行并进入 trajectory；Python sidecar 不再隐藏
运行一个 aux Review LLM。

### 6.4 Review 输出

Review 不应只返回 prose summary，最低限度需要：

```ts
interface ReviewResult {
  id: string
  mode: ReviewMode
  scopeVersion: string
  checkedObjectIds: string[]
  issues: ReviewIssue[]
  proposedPatches: DomainPatch[]
  coverage: CoverageSummary
  decision: 'pass' | 'fail' | 'needs-human' | 'incomplete'
  reviewer: { kind: 'rule' | 'agent' | 'human'; actorId: string }
  createdAt: string
}
```

ReviewResult 可以进入 Research Memory，但“模型建议 pass”不等于 human accepted。

## 7. Memory 的后续优化

### 7.1 不以某个 tool 为中心

Memory ingestion 来源可以是：

- DSH direct user message 与 Session event；
- User/Agent Note；
- Evidence/Claim/Decision/OpenQuestion lifecycle event；
- ReviewResult 和 human decision；
- Artifact revision 与 reuse；
- PreferenceProbe choice 和显式设置；
- deterministic provider failure 或 locator stale signal。

因此 Memory 应监听经过验证的 domain events，而不是只监听 Note tool call。

### 7.2 四类 Memory 使用不同真相载体

| Memory domain | 权威载体 | 主要召回方式 |
|---|---|---|
| Episodic | DSH Session Log | session history / audit |
| Working | Session projection + Investigation Journal | current plan/coverage/open steps |
| Research | Evidence/Claim/Note/Decision/Question/Artifact ledger | ResearchRecallLead → reverify |
| Personalization | Observation/Candidate/MemoryUse ledger | scoped PersonalizationDecision |

它们可以物理共用 SQLite，但 schema、ID、API、retention 和 UI 必须分区。

### 7.3 两套正交控制

```ts
interface PersonalizationSessionPolicy {
  useExisting: boolean
  contributeToFuture: boolean
}

interface ResearchContinuityPolicy {
  recallPriorWork: 'off' | 'suggest' | 'auto-within-explicit-scope'
  contributeResearchState: boolean
}
```

用户可以：

- 不使用个性化，但继续复用旧研究；
- 使用语言/排版偏好，但要求只根据当前文件回答；
- 使用旧研究，但本次不贡献任何长期状态；
- Temporary：两类都不写入。

## 8. Tree update：从 Note side effect 变成 Projection

### 8.1 Tree 的三层结构

```text
Canonical Tree
  title / hierarchy / physical page range / source revision
  immutable per representation

Working Coverage Overlay
  current session read/search/agent/user cursors
  short-lived，可从 Session 重建

Research Overlay
  Evidence/Claim/Note/OpenQuestion/Review/Artifact refs
  versioned、可撤回、可从 Investigation Journal 重建

Personalized Lens
  query + profile conditioned ranking/explanation
  turn-bound，不写回 canonical tree
```

### 8.2 Tree update 的写入来源

```text
Read/Note/Claim/Review/User action
              │
              ▼
      validated domain event
              │
              ▼
       Investigation Journal
              │
              ▼
         Overlay projector
              │
              ▼
      Search index + Web badges
```

Tree 本身不消费任意 Note 字符串；projector 只消费具备 document/revision/locator/status 的对象引用。

### 8.3 最小 overlay 记录

```ts
interface TreeOverlayEntry {
  id: string
  layer: 'working' | 'research'
  documentId: string
  revisionId: string
  representationId: string
  locatorIds: string[]
  projectedNodeIds: string[]
  sourceObject: {
    kind: 'evidence' | 'claim' | 'note' | 'question' | 'review' | 'artifact'
    id: string
    version?: number
  }
  status: 'active' | 'resolved' | 'stale' | 'superseded' | 'withdrawn'
  taskContext?: { investigationId?: string; queryHash?: string }
  createdAt: string
}
```

`projectedNodeIds` 是缓存，不是 identity。PageIndex tree 重建后，可用 locator/representation 重新投影；
无法重锚时标 stale，而不是把旧 node ID 继续当真。

### 8.4 Search 怎样使用 overlay

1. 先执行 document/revision/scope/status hard filter；
2. canonical title/summary/structure 提供基础候选；
3. active Research Overlay 提供额外 recall feature；
4. Personalized Lens 只在候选内调整顺序和解释；
5. 保留 non-history/non-personalized exploration quota；
6. 返回 rank reason 和 overlay object IDs；
7. 真正回答前仍用 progressive Read 获取 source blocks。

Search 不应把所有 page findings 长文本拼进 tree prompt。首版可用 exact key + FTS5；需要语义 rerank 时由
DSH 作为可见步骤执行。

### 8.5 当前 Tree update 的 P0 containment

在 v2 projector 完成前：

- multi-doc session 默认关闭 tree annotation，直到 Note/overlay 强制 `docId + revisionId`；
- 一次 hook 处理自上次 checkpoint 后的所有新 Note，不只 `entries[-1]`；
- 每条 finding 保留 note/evidence ID，不再按 page 合并成无 provenance 字符串；
- invalid/out-of-range locator 返回可见错误，不静默跳过；
- correction/delete/supersede 能撤回对应 hint；
- question/query/task context 明确写入；
- 加 per-node/per-query budget 和 pagination；
- `context_archival` 与 `tree_projection` 使用独立配置名和开关。

## 9. 现实场景与最佳组合

### 9.1 一次性 PDF 问答

用户只问某一页上的日期或数字。

```text
需要：Read
可选：无
不需要：Note / Review / 长期 Memory
```

系统直接 locate → blocks → answer。强迫写 Note 只会增加 tool call 和长期垃圾。

### 9.2 单份长报告的深入理解

用户需要回答多个相关问题，跨章节形成综合判断。

```text
Note      保存假设、OpenQuestion、关键 EvidenceBookmark
Review    最终检查 coverage、冲突和 unsupported claims
Working   保持当前 plan/读过的范围
Tree      显示已读和 unresolved badges
```

若用户不打算以后复用，Research Memory 可以关闭；当前 investigation 仍然完整。

### 9.3 周期性财务分析

分析师每季度阅读 earnings、filing 和 presentation：

- Note 捕获本季异常、管理层解释和需要追踪的指标；
- Review 比较 guidance、actual、口径和 old Claim；
- Research Memory 保存已核验 KPI、OpenQuestion、Comparison 和 brief；
- Personalization 学习用户偏好的 table context 和输出模板；
- Research Overlay 在新报告目录中标出与旧问题相关的 sections。

核心价值是“知道本季改变了过去哪些判断”，不是只记住分析师喜欢表格。

### 9.4 合同谈判与法律 matter

- Note 保存谈判评论、客户偏好、风险疑问；
- ProjectDecision 保存已批准 fallback position；
- Review 执行 clause diff、four-corners、政策和 sign-off；
- Research Memory 保留 clause Claim、旧证据和 negotiation history；
- Tree Compare Overlay 标记新增、删除和受旧 Decision 影响的条款。

用户评论、客户要求和合同事实必须分开显示。过去的 negotiation Note 不能证明当前合同写了什么。

### 9.5 科研文献与系统综述

- Note 捕获假设、方法限制、值得复现实验的想法；
- Review 检查 study design、population、指标可比性和 conflicting evidence；
- Research Memory 保存 Claim/evidence matrix 与 unresolved questions；
- Personalization 只控制术语深度、图表/公式呈现和用户熟悉度；
- Tree Overlay 让新论文的 mechanism/method/results sections 连接到旧反证。

这里最有价值的是保留“问题前沿”，而不是反复生成论文摘要。

### 9.6 审计、尽调与 data room

- Note 是 issue/request/comment 的低摩擦入口；
- Review 负责 evidence sufficiency、period/scope、closure 和 human decision；
- Research Memory 维护 request → evidence → issue → resolution 生命周期；
- 新文件到来后，Tree Overlay 提示可能解决哪些 OpenQuestion；
- Artifact impact 显示哪些 memo 需要更新。

系统不能因找到一份看似相关的新文件就自动把 issue 标 resolved。

### 9.7 工程规范、API spec 与 incident review

- Note 保存 implementation concern 和设计讨论；
- Decision 记录已采用方案和约束；
- Review 比较新 spec、测试和运行事实；
- Research Memory 建立 requirement → decision → code/test/artifact 影响链；
- Tree Overlay 在 v2 spec 中标出影响旧 Decision 的章节。

新 revision 的价值不是再做一次摘要，而是 selective impact analysis。

### 9.8 学习与个人知识积累

- Note 保存自己的解释、疑问和例子；
- Review 变成自测、误解检查和知识 gap 整理；
- Research Memory 保存概念关系与已掌握/待复习状态；
- Personalization 学习解释深度和 representation；
- Preference Probe 比较图示、例题、定义优先等教学形式。

这里可以引入 spaced review，但学习状态不能污染专业文档 Claim 的事实层。

### 9.9 调查报道与政策研究

- Note 保存线索、来源背景和待核验说法；
- Review 检查 attribution、独立来源数量、时间线和反证；
- Research Memory 连接跨年报告、公开记录和旧采访；
- Tree Overlay 在新材料中显示与旧 timeline/claim 的潜在连接。

匿名来源权限和敏感 Note 必须有独立 access policy，不能随通用 semantic recall 泄漏。

### 9.10 团队交接

新成员不需要读完全部 chat history：

- Research Memory 提供 accepted Claims、Decisions、OpenQuestions 和 source links；
- Notes 提供人的 commentary 和上下文；
- ReviewResult 告诉他哪些事项已经签核、哪些仍 disputed；
- DSH trajectory 只在需要审计“当时怎么做的”时展开。

这比一份自动总结更可靠，因为每个结论都有 status 和可回原文的 lineage。

## 10. 产品面不应与 Tool 一一对应

用户看到的产品面建议是：

```text
Evidence Desk          原文、selection、Evidence、轻量 Note actions
Research Notebook      Notes、Questions、Decisions、Related prior work
Claim Ledger           Claims、support/refute、conflicts、versions
Review Workspace       checklist、issues、patches、sign-off
Personalization Center preferences、probes、why-used、forget
Activity/Trajectory    DSH Agent steps、approvals、errors、cost
```

这些产品面背后可以共享 Core command/query API，不要求每个按钮都暴露成模型工具。

## 11. Agent tool 设计空间

### 11.1 方案 A：继续扩展 Note/Review

```text
note(kind=..., refs=..., scope=...)
review(mode=recall|verify|compare|refresh, ...)
```

优点是兼容现有 Skills、tool 数量少。缺点是 `Review` 同时表示 retrieval 和 verification，Note 又容易成为
万能写入接口，schema 会迅速膨胀。

### 11.2 方案 B：Record/Recall 与 Review 分开（推荐）

```text
docatlas_record   Agent 建议写入 checkpoint/claim/question；只提交 typed patch
docatlas_recall   查询 Working/Research state；返回 bounded leads
docatlas_verify   需要时启动 Claim/Artifact Review workflow
```

Note 继续作为人类熟悉的 UI 概念；旧 Note Skill 可作为 `docatlas_record` 的兼容 adapter。旧 Review Skill
迁移为 `docatlas_recall`，把 “Review” 留给真正的核验过程。

并非三个 tool 都必须首发：M1 只需要 `read + record/recall`；Claim Ledger 稳定后再决定 `verify` 是 tool、
Host workflow，还是二者结合。

### 11.3 方案 C：Memory 完全不暴露模型工具

Host 在 pre-step 自动注入 bounded Working/Research/Personalization context，用户通过 UI 管理全部写入。

优点是工具面最小、治理清晰；缺点是 Agent 无法在任务中主动表达“我要找以前关于 X 的工作”，自动
注入也容易召回无关内容。它适合 stable profile，不适合全部 Research Memory。

### 11.4 当前建议

- 不增加一个泛化 `memory(action=...)` 万能工具；
- 保留少量 Agent-facing record/recall verbs；
- personal memory activation、forget、scope 和 policy 只走 authenticated commands；
- Review 作为可见 workflow，而不是隐藏 aux-LLM note selector；
- tool 返回 IDs、status、bounded preview 和 next cursor，不返回无界历史正文；
- source 内容仍统一由 progressive `docatlas_read` 获取。

## 12. 分阶段优化路线

### Phase 0：Contain current risks

1. multi-doc 默认关闭 Tree annotation，直到 document/revision identity 可用；
2. 将 `memory` 配置重命名为 `context_archival`；
3. archive 只处理已由 Evidence/Note 明确覆盖的 read call IDs；
4. Review 增加 max items/chars、cursor 和 deterministic empty/error semantics；
5. 增加 factual-without-evidence、invalid locator、101st note、multi-doc same-page、two-notes-one-turn tests。

### Phase 1：Typed capture and recall

1. 冻结 ResearchNote/OpenQuestion/ProjectDecision/ClaimPatch 边界；
2. selection 自动创建 revision-bound locator/EvidenceAtom；
3. Note UI 根据动作写不同 domain object；
4. SQLite/FTS5 提供 scope/status/time filter；
5. recall 返回 `ResearchRecallLead`，通过 Read reverify；
6. 旧 Note/Review 作为 compatibility adapter。

### Phase 2：Real Review workflow

1. answer coverage 与 locator/hash deterministic checks；
2. Claim challenge + contradiction workflow；
3. ReviewResult/ReviewDecision contract；
4. human accept/edit/reject/waive/sign-off；
5. Review outcome 写 Investigation Journal，并投影到 Tree/Artifact。

### Phase 3：Research Memory and Tree Overlay

1. 跨 session/workspace 的 typed object index；
2. recall-to-reverify 与 source-scope confirmation；
3. overlay projector、rebuild、retract、stale propagation；
4. new revision impact analysis；
5. Related prior work 与 Continue OpenQuestion UI。

### Phase 4：Personalization and controlled learning

1. explicit preferences 和 PreferenceProbe；
2. Observation/Candidate/MemoryUse lifecycle；
3. task-conditioned reading/workflow adaptation；
4. personalization 与 continuity 正交开关；
5. factual non-regression 和 longitudinal eval。

## 13. 独立评测指标

| 能力 | 核心指标 |
|---|---|
| Note | capture latency、anchor success、unverified/orphan ratio、later reuse、clutter burden |
| Recall | lead precision/recall、abstention、pagination completeness、scope leakage、latency |
| Review | issue recall/precision、human agreement、coverage、false pass、review time |
| Research Memory | re-resolution、stale detection、continuity reuse、open-question closure、cross-scope leakage |
| Personalization | preference adherence、update/forget、harmful use、factual non-regression |
| Tree Overlay | navigation recall、time-to-evidence、wrong-doc projection、retract success、prompt/index size |

不能只看最终 answer accuracy。必须定位错误发生在 capture、recall、reverify、review、decision、projection
还是 render。

## 14. 建议决定与未决项

| ID | 状态 | 建议决定 |
|---|---|---|
| NRM-001 | 建议确认 | Note、Review、Memory 是正交能力，不按当前 tool 结构定义领域边界 |
| NRM-002 | 建议确认 | Note 可以无 Evidence，但必须标 epistemic type；进入 factual Claim 时强制 Evidence |
| NRM-003 | 建议确认 | 当前 Review 实质是 Recall，未来语义和 contract 应分离 |
| NRM-004 | 建议确认 | Memory 是 Core service/ledger，不要求存在一个同名 Agent tool |
| NRM-005 | 建议确认 | Tree update 是可重建 projection，不是 Memory 或 Evidence source of truth |
| NRM-006 | 建议确认 | 简单任务允许只用 Read，不强制 Note/Review/Memory |
| NRM-007 | 暂定 | 新 Agent surface 优先采用 record/recall；verify 在 Claim vertical slice 决定 |
| NRM-008 | 暂定 | Note 保留为 UI/product noun，旧 Skill 作为 compatibility adapter |

仍需讨论：

- Scratch/Commentary/Hypothesis 是否共用 ResearchNote schema，还是进一步拆分；
- Agent 什么条件下可以自动创建 OpenQuestion 或 ClaimPatch；
- Review workflow 是一个长运行 Tool、Host state machine，还是 DSH-visible 多步计划；
- Recall 是否允许跨 workspace，默认只 suggest 还是完全关闭；
- Research Overlay 首版按 page/block 还是只按 Claim/section 投影；
- 什么条件允许 ReviewResult 自动 supersede 旧 Claim，哪些必须 human decision；
- 团队 Note、私有 Note 和 source 权限不一致时如何做可见性裁剪；
- 当前 Note/Review 在 upstream compatibility 中保留多久。
