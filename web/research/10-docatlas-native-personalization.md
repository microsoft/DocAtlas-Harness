# DocAtlas 原生个性化架构提案（讨论稿）

> 状态：Draft for discussion，不是最终规格或 ADR  
> 建立日期：2026-08-29  
> 关联文档：[个性化长期记忆](03-personalization-memory.md)、[实施路线图](05-roadmap.md)、[产品路线 v2](08-product-route-v2.md)、[实现研究与验证方案](11-personalization-implementation-research.md)、[DocAtlas Memory 架构](14-adaptive-interface-research-continuity.md)  
> 本轮变化：明确 Personalization Memory 属于 DocAtlas Core；DSH 提供运行时，而不是个性化领域真相。

## 0. 如何阅读和修改这份文档

本文用于承接后续多轮讨论。结论采用三种状态：

- **已确认**：当前产品与架构共识；变更时应记录原因。
- **暂定**：可以指导原型，但在实现前仍需 ADR 或 contract review。
- **待讨论**：刻意保留选择，不让早期代码替我们做产品决策。

本文先固定逻辑所有权，不提前固定进程、语言和数据库。讨论收敛后，稳定结论再分别进入 ADR、wire
contract 和 milestone acceptance；不把整份研究稿直接当成实现规范。

## 1. 本轮已经确认的方向

1. **个性化是 DocAtlas 的原生核心能力。** 它不是一个附加到 DSH prompt 上的通用 memory 插件。
2. **现有 DocAtlas 是可演化的起点，不是可直接交付的成品。** Search/Read/Note/Review 的产品语义值得保留，旧的自由文本状态、会话快照和 Agent Loop 可以重构或退役。
3. **DSH 继续拥有唯一 Agent Loop。** DocAtlas 原生支持 memory，不等于在 Python 或其他进程中再建立隐藏 Loop。
4. **DocAtlas 拥有文档研究的领域真相。** Document Revision、Evidence、Claim、Investigation、Artifact 和 Personalization 都属于 DocAtlas 领域，但必须保持类型和查询边界。
5. **个性化不能参与事实证明。** 它可以改变查找顺序、阅读策略、解释深度和输出形式，不能改变 selector、support/refute、verifier 或 publication gate。
6. **Memory 不应等 Fact Trace 全部完成后才开始设计。** schema、observation 和显式设置应与早期纵向切片并行；会影响证据检索和验证计划的自动个性化必须晚于事实基础的可靠性门槛。

一句话边界：

> DSH 运行研究过程；DocAtlas 理解文档、维护研究状态，并逐步学习用户如何完成文档研究。

## 2. 逻辑所有权

| 层 | 应拥有的能力 | 不应拥有的能力 |
|---|---|---|
| DSH Runtime | Agent Loop、模型路由、Session log、tool lifecycle、approval、cancel/steer、认证 Web shell | DocAtlas 用户画像、证据支持关系、另一套文档研究状态 |
| DocAtlas Core | 文档/版本、representation、Evidence/Claim、Investigation、Artifact、Personalization Kernel | 第二个 Agent Loop、模型凭据、不可观察的辅助模型调用 |
| DocAtlas ↔ DSH Adapter | 把 DSH events 转成 DocAtlas observation；把 recall、why-used 和 commands 暴露给 Loop/Web | 自己定义另一份 memory 语义或绕开 Core 直接改 ledger |
| DocAtlas Web Experience | Evidence Desk、Claim Ledger、Personalization Center；确认、纠正、暂停、遗忘、解释 | 把浏览器 local state 当长期真相、绕开认证直接访问文件或数据库 |

这里的 “DocAtlas Core” 是**领域边界**，暂不表示它必须全部运行在 Python sidecar、TypeScript Host 或单独
服务中。物理边界将在 ADR 中比较，但任一实现都必须遵守同一组 DocAtlas contracts。

## 3. DocAtlas Personalization Kernel

建议把原生能力命名为 `Personalization Kernel`，避免把“存几条摘要”误认为完整 Memory 系统。它至少包含：

```text
Personalization Kernel
├── Observation Collector    结构化接收显式指令、UI 操作、纠正和结果信号
├── Memory Ledger            candidate/version/scope/provenance/status
├── Governance Policy        敏感度、确认、TTL、冲突、删除与导出
├── Recall & Context Builder 按 profile/workspace/task 检索并生成有界上下文
├── Adaptation Policy        决定哪些阅读、计划、解释或布局行为可以改变
└── Use & Outcome Audit      记录为何使用、影响了什么、随后是否被纠正
```

DocAtlas 的原生性体现在：taxonomy、生命周期、scope、研究语义、使用策略和审计均由 DocAtlas 定义。
DSH 的 storage、Session event 或模型只是可替换的运行基础设施和信号来源。

补充研究进一步明确：Personalization Kernel 不只是 Memory Ledger。完整能力为
`governed memory + task-conditioned adaptation policy + observable use + outcome feedback`。因此 recall 的
输出应编译为结构化、有限作用面的 `PersonalizationDecision`，每次应用生成 `MemoryUse`；详细对象草案见
[实现研究](11-personalization-implementation-research.md#6-四个核心对象)。

## 4. 三个状态域必须隔离

```text
Document World                  Investigation World              Personal World
revision/evidence/claim         当前目标/计划/coverage            偏好/熟悉度/工作流
“材料与推导支持什么”             “这次研究正在做什么”              “这个用户通常如何研究”
```

关键不变量：

- `Personal World` 不能成为 EvidenceRelation 的 source；
- 文档事实不能因为经常出现就自动进入用户画像；
- project decision 或 user assumption 必须显式采用，不能由长期偏好偷偷生成；
- memory 关闭前后，selector resolution、Claim support/refute 和 publish gate 结果相同；
- 每次 personalization use 都产生独立 `why-used`，不能混进 “Sources” 列表。

DocAtlas 可以在一个产品和一个本地数据库中管理三者，但需要独立 schema、ID、API 和事务边界，避免
“用户喜欢保守估计”被误作“报告证明了保守情景”。

这里的 Investigation World 可以产生跨 session 的 Research Memory：Evidence-linked Claim、ResearchNote、
Decision、OpenQuestion 和 Artifact。它属于 DocAtlas Evidence/Investigation Core，不属于本提案定义的
Personalization Kernel；关闭 personalization 后仍应正常召回和复核。Personalization Memory 与 Research
Memory 的正交开关、Preference Probe 和跨文档 recall-to-reverify 见
[DocAtlas Memory 架构](14-adaptive-interface-research-continuity.md)。

## 5. 与 DSH Agent Loop 的协作协议

推荐的数据流是：

```text
DSH direct message / tool event / UI command
                    │
                    ▼
        DocAtlas Observation Envelope
                    │
          deterministic or explicit
                    ▼
       candidate / correction / outcome
                    │ user confirmation
                    ▼
          active MemoryVersion
                    │ scoped recall
                    ▼
  plan/ranking/explanation/presentation hints
                    │
                    ▼
      DSH executes the next visible step
```

需要模型判断的 candidate extraction、workflow induction 或 rerank，由 DSH 作为可观察、可取消、可记录的
模型步骤执行；DocAtlas Core 验证结构、应用 policy 并持久化结果。这样既是 DocAtlas 原生能力，也不会
重新引入上游 Search/Review 那种隐藏辅助 LLM。

逻辑接口暂定为：

```text
personalization.observe
personalization.propose
personalization.confirm
personalization.recall
personalization.explain_use
personalization.correct
personalization.pause
personalization.forget
personalization.export
```

DSH 模型可见工具可以映射为 `docatlas_memory_recall` 和 `docatlas_memory_propose`；确认、scope、纠正、
forget 优先使用 authenticated Web commands。接口名和 payload 需在 contract review 后确定。

## 6. 现有 DocAtlas 需要怎样演化

完整上游实现提供了有价值的交互原型，但还不是 Personalization Kernel：

| 当前能力 | 可保留的产品意义 | 需要的演化 |
|---|---|---|
| Note | 人主动留下研究 checkpoint | 拆为 Evidence、Claim、Decision、Task state；退役不可验证的自由 `source` |
| Review | 从既有调查中恢复相关信息 | 变为带 scope/status/revision 的 deterministic retrieval；模型 rerank 进入 DSH trajectory |
| Search/Read history | 观察阅读路径 | 变为有 actor/session/task/outcome 的 observation，不直接等于偏好 |
| workspace JSON/session snapshot | 可恢复工作 | DSH Session log + DocAtlas Investigation/Memory ledgers，不保存第二份对话真相 |
| tree enrichment | 已读信息影响后续导航 | canonical tree 与 personalized/query overlay 分离 |

因此“接入 DocAtlas”实际包含两部分：

1. 提取并复用可靠的文档读取、预处理和导航能力；
2. 在本项目中发展新的 DocAtlas domain core，包括 evidence identity、Claim Ledger 和 Personalization Kernel。

是否将通用修复回馈上游、保持下游模块，或形成独立 core package，应逐项决定；不能通过长期修改只读
`.sources/` checkout 来维护产品。

## 7. Personalization Memory 应该从什么时候开始落地

不是“现在全开”或“最后再做”的二选一，而是按影响风险逐层开放：

| Track | 与主路线的关系 | 交付 | 此时允许的影响 |
|---|---|---|---|
| K0 Domain foundation | 与 M0 Evidence contracts 并行 | ownership ADR、Observation/MemoryUse envelope、scope/ID/privacy rules | 无运行时个性化 |
| K1 Observation | 随 M1 read vertical slice | 显式指令、UI action、steering/correction 的结构化事件；可检查/删除 | 仅记录，不改变 Agent 决策 |
| K2 Explicit profile | 随 M2 Evidence Desk | 用户主动设置 reader/layout/language/evidence display；why-used | UI 与解释形式，不改变 evidence ranking |
| K3 Candidate ledger | 随 M3 Claim Ledger | candidate/version/provenance/confirm/correct/forget；Personalization Center 最小版 | 低风险 plan hint，默认可见且可撤销 |
| K4 Controlled adaptation | M3 事实门槛通过后 | workflow learning、personalized Lens、reading/verification strategy | ranking/plan，但保留非个性化探索预算且 verifier 不变 |
| K5 Longitudinal learning | 稳定版后 | 跨项目更新、provider negative lesson、可选团队/同步 | 必须通过纵向安全和隐私评测 |

这意味着 K0/K1 是近期基础工作；原路线中的 M4 应理解为**激活和扩大影响面**，不是第一次开始实现
Memory。

## 8. 物理实现尚未定案

逻辑所有权已经明确，但以下三种部署都需要原型比较：

| 方案 | 优点 | 主要风险 |
|---|---|---|
| Host 内 DocAtlas Core（TypeScript） | 与 DSH events/Web command 集成直接 | 与上游 Python 文档核心分裂，可能出现双领域实现 |
| Python DocAtlas Core + 窄 RPC | 贴近上游读取与索引能力 | 生命周期、并发、迁移和 UI command 需要可靠长驻边界 |
| 分层 Core（语言中立 contracts，Host governance，Python document providers） | 顺应现有架构，职责可渐进迁移 | 边界设计复杂，必须防止逻辑散落在 adapter |

当前暂定约束：

- `contracts/` 是跨语言 wire 真相；
- Python 不拥有 Agent Loop、conversation 或模型 credentials；
- Memory Ledger 是 DocAtlas domain store，即使底层暂时借用 DSH `storage-domain` 或 Host 管理的 SQLite；
- 浏览器只能通过 DSH authenticated Connection 访问；
- 数据库位置、加密、profile identity 和多用户边界在实现持久化前签 ADR。

## 9. 第一版可验证闭环

首个个性化闭环不需要自动“猜懂用户”：

1. 用户在 Evidence Desk 选择“关键数字必须显示表格上下文”。
2. DocAtlas 保存一条 workspace-scoped explicit preference，带 UI action provenance。
3. 下一次研究开始时，DocAtlas recall 返回该 memory 和 rank reason。
4. DSH Agent plan 显示“将核对原表格”，并记录 `MemoryUse`。
5. 回答仍由 EvidenceAtom/Claim verifier 判定；偏好只改变读取与展示计划。
6. 用户从 why-used 打开、修改、暂停或忘记该 memory。
7. personalization on/off 的事实评测结果一致。

这个闭环同时验证原生 ownership、DSH 协作、用户控制和 non-interference，比先做 embeddings 或自动画像
更有价值。

## 10. 后续讨论清单

建议按以下顺序收敛，每一轮只冻结一类决定：

1. **领域与运行边界**：Core 在 Host/Python 如何分工，adapter 能否包含 policy。
2. **Identity 与 scope**：profile、workspace、collection、document、task family 如何继承和覆盖。
3. **Observation contract**：哪些 DSH/UI 事件值得记录，raw retention 与删除如何关联。
4. **Lifecycle 与 promotion**：explicit、repeated behavior、correction、negative lesson 的阈值和审批。
5. **Storage 与 privacy**：SQLite/DSH storage、migration、backup、incognito、export/forget 边界。
6. **Recall 与作用面**：何时可影响 Lens/ranking/plan，怎样保留探索和显示 why-used。
7. **Evaluation**：纵向用户 fixtures、harmful-use、update/abstention 与 evidence non-regression 门槛。

仍待回答的关键问题：

- Personalization Ledger 与 Investigation Journal 同库分 schema，还是独立数据库？
- 单机多 profile 的 actor identity 由谁创建和认证？
- 是否允许“仅本次使用、不写入 observation”的 incognito session？
- 用户删除源 Session 后，derived memory 应 cascade-delete、orphan 还是 redact？
- 熟悉度是用户显式设置，还是允许可衰减的低置信推断？
- 哪些记忆只影响 Web，哪些可以进入 DSH model context？

## 11. 决策记录

| ID | 状态 | 当前决定 | 后续动作 |
|---|---|---|---|
| PERS-001 | 已确认 | Personalization Memory 属于 DocAtlas Core，不属于 DSH 通用 memory | 在正式 ADR 中固化 ownership |
| PERS-002 | 已确认 | DSH 保持唯一 Agent Loop；DocAtlas 不持有模型 credentials | 加入 contract/architecture tests |
| PERS-003 | 已确认 | Personal Memory 与 Evidence/Claim 类型隔离，不参与事实支持 | 建立 personalization on/off non-regression test |
| PERS-004 | 已确认 | Memory foundation/observation 提前，影响检索和验证的 activation 后置 | 同步 M0–M4 milestones |
| PERS-005 | 暂定 | 使用 Observation → Candidate → Active → Use/Outcome 的 versioned ledger | 下一轮审查 lifecycle payload |
| PERS-006 | 待讨论 | Host、Python 和 SQLite 的物理边界 | 编写 runtime/storage ADR |
| PERS-007 | 待讨论 | profile identity、sync 和团队 memory | 首版本地单用户边界先行 |
| PERS-008 | 暂定 | Recall 先经过 identity/scope/risk/use admission，再进行相关性排序 | 用跨域和空结果 fixtures 验证 |
| PERS-009 | 暂定 | Recall 编译成结构化 `PersonalizationDecision`，不直接注入任意 memory 文本 | 审查 effect 枚举和 prompt adapter |
| PERS-010 | 暂定 | v0 采用 deterministic rules + SQLite/FTS5；embedding、graph、fine-tuning 后置 | 与简单 profile injection 做基线对照 |
| PERS-011 | 暂定 | 个性化必须按 Observation → Use → Outcome 的全链路评测 | 建立 DocAtlas 纵向 benchmark |

当 `PERS-006`、identity/scope、lifecycle contract 和第一版 acceptance 被批准后，本提案可以拆分为正式
ADR；在此之前，它保留讨论状态。
