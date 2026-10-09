# 个性化长期记忆：让 DocAtlas “越用越懂你”

> 研究日期：2026-08-29  
> 核心原则：个性化影响“找什么、怎么读、怎么呈现”，不能改写“原文说了什么”。
> 架构归属：Memory taxonomy、lifecycle、recall policy 与 use audit 是 DocAtlas Core 原生能力；DSH 提供
> Agent Loop、Session signals 和执行基础。边界讨论见[原生个性化架构提案](10-docatlas-native-personalization.md)。
> 2026-08-30 补充调研、运行闭环、contract 草案和评测计划见
> [个性化实现研究与验证方案](11-personalization-implementation-research.md)。
> Research Memory 是通用 DocAtlas Core 能力，不属于 Personalization Kernel；受控偏好校准和跨文档
> research continuity 的完整边界见 [DocAtlas Memory 架构](14-adaptive-interface-research-continuity.md)。

## 结论先行

“越用越懂你”不能等价于“每轮自动总结聊天，再把摘要全塞进 prompt”。真正可销售、可长期信任的
个性化，需要同时满足：

- 有用：能改变检索、阅读策略和呈现，而不只是记住昵称；
- 可解释：每次使用都能回答“用了哪条记忆、为什么、来自哪里”；
- 可纠正：新偏好不会物理覆盖旧偏好，冲突和时间变化可追溯；
- 可控制：用户能预览候选、限定 scope、暂停、编辑、忘记和导出；
- 可验证：任何由文档得出的事实仍然回到 document revision + page + quote/bbox；
- 有边界：敏感信息不自动学习，模型推断不会直接成为 active memory。

推荐把产品状态明确拆成三类：

```text
S_doc   文档事实与证据：tree、page、figure、finding、locator
S_task  当前调查工作记忆：问题、读过的页、计划、会话 findings
S_user  跨会话个性化：偏好、熟悉度、关注点、流程、约束、历史反馈
```

`S_doc` 由原文约束，`S_task` 由 DSH Session log 重建，只有 `S_user` 是本章讨论的长期个性化。
更完整的 Memory Architecture 会把 `S_doc` 再区分为 Source World 与 derived Research Memory：前者是
原始材料，后者是跨 investigation 的 Claim、Note、Decision、OpenQuestion 和 Artifact。关闭个性化不能
关闭这些通用研究资产。

## 1. 先区分“记忆”这个词的四种含义

现有 DocAtlas 已经有 Note/Review “memory”，但它是当前 investigation 的工作记忆，不是用户画像。

| 名称 | 生命周期 | 示例 | 权威来源 |
|---|---|---|---|
| 原始 episode | 永久或随会话删除 | DSH 用户消息、助手消息、tool result | DSH Session log |
| 调查工作记忆 | 一个 session / document set | 已读页、finding、下一步计划 | 标准 tool events + Session Projection |
| Research Memory / 文档知识资产 | 跨 investigation，绑定 source revision | “报告 p.17 给出的净负债为…”以及对应 Claim/Question | Evidence/Claim store + locator |
| 用户长期记忆 | 跨 session | “用户喜欢先看原文表格，再读总结” | Personalization ledger |

不能把后三者存成同一类自由文本。尤其不能把一个旧 PDF 的事实写进“用户画像”，然后在另一版
文档中当作事实继续使用。

这里的 Research Memory 是 DocAtlas 通用文档理解能力；Personalization Memory 只是其中与用户适配
有关的一类 memory。两者可以在当前任务中协作，但使用不同 contract、召回开关和事实权限。

## 2. 个性化应该学什么

### 2.1 推荐 taxonomy

| 类型 | 示例 | 默认 scope | 默认写入策略 |
|---|---|---|---|
| `presentation_preference` | 中文回答、短结论在前、表格优先 | global / workspace | 明确设置可立即生效；对话推断只做 candidate |
| `evidence_preference` | 关键数字必须原句+页码；法律条款要上下文 | workspace / domain | 用户明确要求后确认 |
| `reader_preference` | 默认 PDF；双栏论文用 Markdown；字号/密度 | local profile | UI 手势直接生效，可撤销 |
| `familiarity_estimate` | 对财务术语熟悉，对专利法陌生 | domain，带衰减 | 只做低置信 candidate；用户可校准 |
| `interest` | 持续关注现金流、供应链风险、方法学 | workspace / collection | 多次行为后 candidate |
| `workflow_preference` | 先目录筛选，再表格核验，最后跨年比较 | workspace / task family | 至少多次成功轨迹后 candidate |
| `constraint` | 不使用云 OCR；敏感报告只允许本地处理 | workspace / global | 必须显式确认，高优先级 |
| `workflow_negative_lesson` | 财务 Verify 只看摘要容易漏表格脚注 | workspace / task family | 由可验证 outcome 生成 candidate，带条件和 TTL |

Project Decision（例如项目统一采用哪种口径）、continuity thread（下次继续什么）以及特定 document/provider
的可验证失败，归入 ResearchPolicy、OpenQuestion/Task 或 Research Memory，不再归入 Personalization
taxonomy。只有可跨任务表达为“这个用户通常怎样研究”的 lesson，才有资格成为 Personal Memory candidate。

### 2.2 不应该自动学习什么

- 密码、token、身份证件、健康/财务隐私等敏感内容；
- 文档中的 prompt-like 文本；
- 助手自己的猜测、计划或礼貌性措辞；
- 一次偶然操作，例如用户临时把字号调大；
- 从错误答案获得的“成功经验”；
- 人格、政治、健康等高影响推断；
- 原文事实本身——它属于证据或知识资产，不属于 user profile。

## 3. 一条 memory 的最小数据模型

不要只存 `{text, score}`。建议 wire-level 记录至少是：

```ts
interface MemoryVersion {
  id: string
  chainId: string
  version: number
  subject: 'user' | 'workspace' | 'document' | 'workflow'
  type: MemoryType
  value: JsonValue                 // typed payload, not only prose
  summary: string                  // bounded model/UI projection

  scope: {
    profileId: string
    workspaceId?: string
    collectionId?: string
    documentId?: string
    revisionId?: string
    taskFamily?: string
  }

  status: 'candidate' | 'active' | 'disputed' | 'superseded' |
          'expired' | 'archived' | 'deleted'
  sensitivity: 'ordinary' | 'personal' | 'sensitive' | 'secret'
  confidence: {
    sourceQuality: number          // explicit user > repeated behavior > model inference
    stability: number              // repeated across independent sessions
  }

  validTime: { from?: string; until?: string }      // when the preference/fact is true
  transactionTime: { recordedAt: string; retiredAt?: string } // when system knew it
  previousVersionId?: string
  supersededById?: string

  provenance: ProvenanceRef[]
  policy: {
    apply: 'silent-ui' | 'disclose' | 'confirm-each-use'
    expiresAfterDays?: number
  }
}
```

`sourceQuality` 和 `stability` 分开，避免“被频繁召回”被误当成“越来越真实”。使用次数只说明效用，
不能提高事实置信度。

### 3.1 Provenance

```ts
type ProvenanceRef =
  | { kind: 'user-message'; sessionId: string; seq: number; excerpt: string; hash: string }
  | { kind: 'ui-action'; action: string; at: string; previous?: JsonValue; next: JsonValue }
  | { kind: 'document-evidence'; locator: DocumentLocator; quoteHash: string }
  | { kind: 'memory-version'; id: string }
  | { kind: 'import'; source: string; importedAt: string }
```

保留一个受限 excerpt 能让原 Session 被归档或不可用时仍解释来源；完整展开优先回到 Session log。
如果源会话被删除，UI 要显示 `source unavailable`，不能假装 citation 仍完整。

## 4. 从 observation 到 active memory

```text
Observation
   │ deterministic UI event / explicit user statement / model extractor
   ▼
Candidate ── reject ──────────────> Archived
   │ confirm / repeated evidence
   ▼
Active ── contradiction ──────────> Disputed
   │ revised                         │ resolve
   ▼                                 ├─> Active(new version)
Superseded                           └─> Deleted/Archived
   │ TTL
   └───────────────────────────────> Expired
```

状态转换规则：

1. candidate 永远不能直接参与高影响决策；
2. 同一 chain 最多一个 active version；
3. revision 是“旧版 superseded + 新版 active”的一个原子操作；
4. disputed 默认不召回，除非问题本身是让用户解决冲突；
5. delete 立即退出索引和 prompt；是否保留 tombstone 由用户选择；
6. 原始 provenance 与 provider 记录可能仍存在，忘记页必须说清楚删除边界。

## 5. 写入策略：显式优先，推断渐进

### 5.1 风险分级

| 等级 | 内容 | 行为 |
|---|---|---|
| L0 | 纯本机 UI 视图状态 | 用户手势直接写，提供 undo/reset；不进模型 prompt。 |
| L1 | 用户明确表达的普通偏好 | 生成可见 candidate；“以后都这样”可一键确认。 |
| L2 | 重复行为、熟悉度、工作流推断 | 至少跨 2 个 session、3 次独立 observation 后进入 inbox；不静默激活。 |
| L3 | 约束、身份、敏感内容、会影响事实选择的规则 | 必须明确确认，默认 workspace scope；secret 永不保存。 |

阈值不是“真理评分”，而是减少骚扰的产品策略。候选 inbox 应合并近重复项，例如“喜欢短回答”连续
出现五次，只展示一个 candidate 和五条来源。

### 5.2 生成来源

- **UI deterministic**：PDF/Markdown 模式、字号、panel 宽度；最可靠且零模型成本。
- **显式语言**：用户说“以后请…”。模型可调用 `docatlas_memory_propose`，但结果仍是 candidate。
- **纠正信号**：用户说“不要这样”“我说的是…”。优先创建对旧版本的 dispute/revision。
- **成功轨迹**：只有在回答被接受、引用被打开或用户显式确认后，才作为 workflow observation。
- **turn-end extractor**：可选后台辅助模型，只处理当前 turn 的有界文本，输出候选与 source seq；失败
  或截断时写入零条。

不推荐每一轮都对全部历史做总结。它成本高、产生重复、会把助手幻觉滚入长期状态。

## 6. 冲突、变化与时间

用户偏好会变。采用 Zep/Graphiti 的 bi-temporal 思路：

- `validTime`：现实中何时适用，例如“2026-08 起偏好中文”。
- `transactionTime`：系统何时记录、撤回或纠正它。

召回时先按 scope 和 valid time 过滤，再选 chain 的 active version。scope 冲突按更具体者优先：

```text
document revision > collection > workspace > domain > global
```

但“更具体”只覆盖相同 type/key。例如 workspace 的 `answer_language=English` 可以覆盖 global Chinese；
`evidence_policy=quote-required` 不能覆盖语言。

对独立来源的语义矛盾，不要自动让“最新”获胜：标记 disputed、同时保留两边 provenance，让用户选择。
只有明确 correction/revision 才能自动关闭旧 version 的 validity。

## 7. Recall：不是简单 top-k

### 7.1 先硬门，后排序

```text
identity/profile gate
  → scope gate
  → active + time-valid gate
  → sensitivity/use-policy gate
  → lexical/entity/temporal candidate retrieval
  → optional semantic retrieval
  → provenance/stability/utility rerank
  → diversity + token budget
  → render as untrusted data with ids
```

第一版应以确定性 tier 为主：

1. exact key/tag 和 scope；
2. FTS/BM25，中文可用 n-gram；
3. 时间表达扩展与 active thread；
4. 可选 embeddings，与 lexical 用 RRF 融合；
5. MMR/同 chain 去重，避免十条同义偏好占满 prompt。

访问频率只在同一相关性 tier 内作为 utility tie-break。必须保留一部分非个性化检索预算，防止长期只
看用户过去关注过的章节而形成 information bubble。

### 7.2 两条进入上下文的路径

| 路径 | 内容 | 建议上限 | 更新时机 |
|---|---|---:|---|
| Stable Profile | 高置信、低变化偏好/约束 | 约 8 项，600–1000 tokens | 新 session 冻结；明确 revision 后换版本 |
| Query Recall | 本题相关 thread/workflow/history | 约 4–6 项，≤1200 tokens | `agent/pre-step` 或显式 recall tool |

不要在无匹配时“按最近记忆兜底”塞一批无关内容。无结果就是有效结果，也是 LongMemEval 的
abstention 能力所要求的行为。

### 7.3 注入格式

记忆是 untrusted background data，不是权限或指令：

```xml
<docatlas-user-context schema="v1" untrusted="true">
  <memory id="m_42" type="evidence_preference" scope="workspace:w_7">
    Key numerical claims should include an exact quote and physical PDF page.
  </memory>
</docatlas-user-context>
```

渲染时 escape delimiter，禁止记忆赋予工具权限、覆盖当前用户消息或要求忽略安全策略。

## 8. 个性化真正影响哪些产品行为

| 环节 | 可个性化 | 不可个性化 |
|---|---|---|
| 文档选择 | 默认 collection、常用报告系列 | 偷偷排除其他文档 |
| Tree/Lens | 排序、展开深度、风险/时间/实体 Lens | 修改 canonical heading/page range |
| 阅读计划 | 先原文/先目录/先表格、默认 challenge 深度 | 放宽 publication verification gate |
| Evidence | 引用粒度、是否需要 quote/bbox/figure | 改写 quote 或 citation |
| 回答 | 语言、长度、术语深度、表格/叙述 | 把用户偏好当成文档事实 |
| UI | PDF/Markdown、panel、字号、follow 模式 | 隐藏来源或“不确定”状态 |

用户感知最强的不是“它记得我的名字”，而是：打开一份新年报，它已经知道我通常先比较现金流和
风险项；答案仍把每个数字精确带回新年报原页，并告诉我此次为何采用这个阅读策略。

偏好不必只靠被动推断。系统可以偶尔用共享同一 Claim/Evidence backbone 的两个 renderer，只改变回答
顺序、解释深度或 evidence density，让用户选择更适合的版本。这个 `PreferenceProbe` 产生 observation，
不能改变事实，也不能因一次选择直接形成 global active memory；完整设计见
[自适应理解与跨文档研究连续性](14-adaptive-interface-research-continuity.md)。

## 9. DSH 接入点

本节描述 DocAtlas Personalization Kernel 如何接入 DSH，不表示 DSH 拥有 Personal Memory。模型可见工具、
Host hooks 和 Web commands 都是 adapter；Memory 的结构、状态转换、scope 和治理规则由 DocAtlas 定义。

推荐工具与事件：

```text
docatlas_memory_recall     模型主动查找，read-only
docatlas_memory_propose    只写 candidate，不可直接 active
```

用户确认、编辑、scope、forget 应优先走 Web UI authenticated command，而不是给模型一组可破坏治理
关系的工具。高影响写入如果从模型工具发起，必须走 DSH approval，并把 proposed value、scope 和
来源展示给人。

Host hooks：

- `agent/pre-step`：读刚 claim 的 direct user input，做有界 query recall；
- `systemPrompt.section`：只放 stable profile；
- `turn/end`/Session event observer：生成候选和使用 outcome，不阻塞 Agent idle；
- `tools/result`：观察 DocAtlas evidence usage，但不能把一次 tool read 自动提升为长期偏好；
- Session Projection：把“本轮用了哪些 memories”回放给 UI。

每次回答记录 `MemoryUse`：memory version、目标 session/turn、rank reason、注入字节数、用户后续
accept/correct/dismiss。这是后续“越来越懂”的训练信号，也是误用审计。

Memory 被使用时可以像 source citation 一样显示，但必须使用不同的视觉和语义：

```text
Document evidence   证明“这个 claim 为什么被材料支持”
Memory why-used     解释“为什么这次采用这个阅读/表达/验证策略”
Project instruction 说明“本 investigation 的显式规则是什么”
```

三者不可出现在同一个“Sources”计数里。Personalization 开关 on/off 时，Claim support/refute、selector
resolution 和 publication gate 的结果必须完全一致；只能改变 source ranking、计划、解释深度与呈现。

## 10. 存储架构

### 10.1 推荐的生产拆分

| 数据 | 推荐介质 | 原因 |
|---|---|---|
| DocAtlas bounded stable profile、UI prefs、当前 ledger revision | DSH `storage-domain` adapter | schema validated、同步读、适合 bounded snapshot；它只是存储底座，不拥有 memory 语义。 |
| DocAtlas observation/candidate/version/provenance/use ledger | DocAtlas-owned SQLite（物理进程待 ADR） | 需要多表事务、唯一 active version、FTS、schema migration 与查询。 |
| 原始对话 | DSH Session log | lossless episode，不复制成另一份真相。 |
| 文档证据 | DocAtlas evidence/artifact store | 绑定 document revision 和 locator，可能含大文本/图像。 |

`storage-domain` 的写入是单 domain 串行且 durable-first，非常适合 profile；但当前没有 migration、
跨表 transaction、查询索引或跨进程通知。把完整 memory graph 强塞进 KV 会让 candidate promotion、
version revision 和 FTS 难以保持原子性。

无论采用哪种介质，schema、lifecycle 和 query policy 都属于 DocAtlas Personalization Kernel。具体是由
Host 打开数据库、sidecar 持有数据库，还是两者通过窄 RPC 分工，需要单独 ADR；不能让 adapter 的临时
存储选择反向定义领域模型。

如果首版不愿引入 SQLite，可以做受限 KV beta：每个 chain 一个 record、总量 ≤500、无 semantic graph，
版本升级前强制 export/migrate。它不应被描述为最终架构。

### 10.2 身份

DSH 的 anonymous user id 只是一个 harness-home correlation UUID，官方文档明确说不能识别账户或跨
home 关联。不要把它当 PersonId。

- 单用户本地版：显式创建 `profileId = local-default`，用户可重命名/导出；
- 多 profile：由 DocAtlas 创建 profile，用户选择；
- 团队/云部署：必须由认证层提供 actor identity，不能从路径、机器或浏览器猜测。

workspace scope 使用 DSH WorkspaceId；canonical path/fingerprint 只用于检测移动或误绑定，不作为人身份。

## 11. Personalization Center 的用户控制

不建议做一个只有“记忆列表”的设置页。至少需要四个视图：

1. **Candidate Inbox**：为什么建议、观察次数、来源、建议 scope、接受/编辑/拒绝。
2. **Active Profile**：按呈现/证据/熟悉度/工作流分类，支持 pause 和优先级。
3. **Why used**：本轮用了什么、如何影响 tree ranking/阅读/回答；一键“这次不要用”“以后别用”。
4. **History & conflicts**：version chain、valid time、disputed 状态、原 session/document provenance。

用户在 composer 发送前可看到高影响 recall chips；低风险 UI 偏好可以静默应用，但仍写 usage audit 并
可从“为何是这个布局”打开解释。

## 12. 隐私、删除与威胁模型

- 默认 local-only；任何 cloud sync 都按 memory type/scope 单独 opt-in。
- DSH 的[数据处理声明](https://www.deepseek.com/harness/en/data-processing/)明确区分本地默认处理与用户
  主动配置的外部模型、Web、MCP、插件服务；每个 DocAtlas provider 都要独立展示将发送的字段和保留策略。
- secret detector 在写入前运行，错误信息只报类别，不回显值。
- SQLite/JSON 默认未加密；必须明确依赖 OS 磁盘权限/加密，不能宣传“加密记忆”。
- 文档、网页和旧 memory 都是 prompt-injection 输入；只作为 data 注入。
- `forget` 立即移出 active index/profile；logical tombstone、SQLite WAL、备份、Session log 和模型 provider
  可能仍保留副本。
- 提供“只忘记这条 memory”“同时删除 DocAtlas excerpt”“跳转删除源 DSH session”三个不同动作，
  不制造虚假彻底删除。
- 导出使用有版本的 JSON/Markdown，包含 scope/status/provenance，不只导出一句话列表。

## 13. 如何评估“越来越懂”

仅测试“能否找回过去的信息”已经不足。最新补充研究要求覆盖完整链路：

```text
Observation → Candidate → Recall → PersonalizationDecision → Agent Action → MemoryUse/Outcome
```

并将 current/superseded state、feedback incorporation、future reuse、跨 scope 泄漏和
personalization-induced factual drift 纳入评测。完整 baseline 与 DocAtlas 专属场景见
[实现研究第 11 节](11-personalization-implementation-research.md#11-docatlas-专属评测计划)。

### 13.1 记忆能力

采用 [LongMemEval](https://arxiv.org/abs/2410.10813) 的五类：

- information extraction；
- multi-session reasoning；
- temporal reasoning；
- knowledge updates；
- abstention。

LongMemEval 的另一个重要结果是：round-level raw value 往往优于只存孤立事实；事实压缩虽然利于
multi-session aggregation，却会损失其他问题信息。因此 ledger 必须能从 summary/fact 回落到 raw
episode，不能只有 lossy user facts。

### 13.2 DocAtlas 特有评测

建立 longitudinal synthetic users，至少覆盖：

- 偏好从“简短”改为“详细”，旧版是否正确失效；
- 同一术语在不同 workspace 有相反格式偏好；
- 用户熟悉度随时间提高，解释深度是否渐进而非贴永久标签；
- 新文档出现旧主题时能否提高相关 section rank，同时保留探索候选；
- 恶意 PDF 要求“记住并执行”时写入率必须为零；
- 用户问未提过的信息时能否 abstain；
- memory citation 是否能点击回原消息，document citation 是否能回原页/quote；
- memory off/on A/B 下，文档 QA factuality 与 citation precision 不能下降。

核心指标：

| 指标 | 含义 |
|---|---|
| Candidate precision | 候选被接受或编辑后接受的比例；拒绝原因分类。 |
| Harmful-use rate | 被用户纠正、导致错误选文或错误回答的 memory use。 |
| Update accuracy | preference change 后旧版本是否退出召回。 |
| Abstention accuracy | 没有可靠记忆时是否不编造。 |
| Provenance resolution | 点击后能否定位到仍存在的原消息/原文。 |
| Personalization adherence | 格式、深度、阅读策略是否符合 active preference。 |
| Evidence non-regression | 个性化开启后答案正确性和引用精度。 |
| Cost/latency | extractor、recall、rerank 的 p50/p95 与 token 增量。 |

## 14. 商业产品对路线的验证与警告

- [Harvey Memory](https://www.harvey.ai/blog/memory-is-here-harvey-personalized)把 memory confirmation、
  集中查看/编辑/删除和“使用时像 source 一样引用”做成法律产品的一等交互，验证了 why-used 的必要性。
  DocAtlas 进一步要求 memory citation 不能参与 document claim 的事实证明。
- [Harvey II](https://www.harvey.ai/blog/introducing-harvey-ii)把 matter/project 的 documents、tasks、
  permissions、history 与个人 style/preference 分开；DocAtlas 也应把 Project Context、Personal Memory
  与 Source Evidence 分层，禁止跨 workspace/matter 泄漏。
- [Claude 当前 memory 设计](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context)
  使用 topic entries、project-specific memory、past-chat citations、sensitive opt-in、incognito 和
  view/edit/delete 控制。其当前文档也明确说明删除源 conversation 不一定自动删除相关 memory entry；
  DocAtlas 必须定义 `cascade-delete | orphan | redact` policy，不能留下伪装成完整 provenance 的链接。
- [Gemini Notebook chat customization](https://support.google.com/gemininotebook/answer/16179559?hl=en)与
  [Copilot notebook instructions](https://support.microsoft.com/en-us/microsoft-365-copilot/provide-custom-instructions-for-your-microsoft-365-copilot-notebook)
  证明 tone/length/role/focus 适合显式 instruction；不要让 memory extractor 重复推断用户已经设置的内容。

商业产品的共同方向是“从编辑和纠正中学习”。DocAtlas 只把结构化 correction、accepted claim edit、
published artifact revision 当强信号；scroll/click 只能是弱候选，Agent 自己的输出不能成为偏好证据。

## 15. 研究借鉴与不照搬之处

- [MemGPT](https://arxiv.org/abs/2310.08560)：借鉴 tiered context 和按需 paging；不让模型无审批地
  自由改写核心用户画像。
- [Generative Agents](https://arxiv.org/abs/2304.03442)：借鉴 observation → reflection 与
  relevance/recency/importance；不把访问频率当真值，也不照搬游戏世界的 importance prompt。
- [Mem0](https://arxiv.org/abs/2504.19413)：借鉴 extraction/update 分离和 ADD/UPDATE/DELETE/NOOP
  决策；生产中 DELETE 改为 version invalidation，并加人类治理。
- [Zep/Graphiti](https://arxiv.org/abs/2501.13956)：重点借鉴 raw episode、derived semantic layer、
  bi-temporal validity 和 invalidated edge；图数据库留到关系型问题真的需要时。
- [A-Mem](https://arxiv.org/abs/2502.12110)：借鉴原子 note 与动态链接；任何对旧 memory 的“evolution”
  必须产生新 version，不原地重写来源。
- [Dynamic Cheatsheet](https://arxiv.org/abs/2504.07952)：借鉴从反馈提炼可复用 workflow；只在
  outcome 被验证后学习，避免错误策略在相似任务间传播。
- [`dsh-native-memory`](https://github.com/highland0971/dsh-native-memory/tree/9acd2ca676fc58a8c8d7a17e59f2d39fcb4c9b58)：借鉴 storage-domain、审批、session seq citation 和
  bounded profile；其固定版本基于较早 DSH，Web route 等实现必须按当前 Connection 边界重做。
- [`dsh-memory-spaces`](https://github.com/icearia0219/dsh-memory-spaces/tree/ac8b58d087ff5a50e9a32030bd56cffe61da069d)：借鉴 source/consumer 分权、automatic/confirm/paused、
  version lifecycle、transactional migration 和 pre-send preview。

## 16. 建议作为大卖点的表达

比“AI 记住你的一切”更可信的表达是：

> DocAtlas 会逐步学会你的阅读方式、证据标准和研究重点。每次使用都有来源和原因；你可以查看、
> 修改或忘记。它会改变怎么找、怎么读、怎么讲，但绝不会改变原文。

这是 Personalization Memory 的承诺，不包含全部 DocAtlas Memory。跨文档保存已核验 Claim、旧 Note、
Decision 和 OpenQuestion 属于 Research Memory；它带来的“记得你已经研究过什么、知道新文档改变了
什么”是另一条独立产品价值。
