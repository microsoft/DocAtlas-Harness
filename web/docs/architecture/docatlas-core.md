# DocAtlas Core 与产品边界

> 当前目标设计；由 [ADR-021](../adr/021-docatlas-first-pi-runtime.md) 确认。
> Core stores/document/研究/偏好应用已提取；ADR-045把人类Claim/Review与本地成果接入产品，完整迁移/业务/恢复验收仍待。
> 已确认原型后的具体模块/接口/恢复与提取顺序见 [后端详细设计](backend-delivery.md)。

## 1. 核心意味着什么

DocAtlas Core 不是“几个 PDF tools”，也不等同于原版 Python harness。它是文档、证据、研究工作、用户适配和
应用策略的权威。Pi 是完整的通用执行引擎。产品不依赖 DSH Web 或 Pi TUI 来定义它的工作对象和交互。

```text
DocAtlas Web / future desktop / controlled CLI
                      │ authenticated product commands and read models
               DocAtlas Application (apps/server)
                 ├─ Core: documents / evidence / research / personalization / workflows
                 ├─ Pi runtime adapter: native AgentSession + full controls/resources
                 └─ Document service adapter: supervised Python, index, rendering, providers
```

Web、Pi adapter、Python adapter 依赖 Core 的 contracts/ports；Core 不反向 import Pi、DSH、React 或插件。
不为了重用而建立几十个包：先用一个按 domain 分目录的 Core，只有实际依赖/部署边界成立才拆包。

## 2. 模块职责

| 模块 | 核心对象/职责 | 当前迁移输入 |
|---|---|---|
| documents | Library、revision/representation、scope、ingest job、document capability | source-scope-store、library-service/discovery、sidecar |
| evidence | Locator、EvidenceAtom、AnswerManifest、Selection、focus admission | answer-manifest、selection-service、reader contracts |
| research | Note/Question/Decision/Policy、Claim/Review/Artifact、Continuity、Tree Overlay | 三类 Investigation store、continuity-service |
| personalization | observation/candidate/version/decision/use/probe、consent、forget/export | personalization-store 和 M6 contracts |
| workflows | run admission、Explore/Verify/Publish、checkpoints、human decisions、mixed-task provenance | Host orchestration + reviewed new runtime ports |
| ports | DocumentPort、RuntimePort、Actor/Clock/Asset access、execution identity | 从具体 Host 类型中提取；不是复制宿主 API |

`apps/server` 负责 composition、认证、事件投影/投递、存储路径/部署、进程监督。`packages/runtime-pi` 负责所有
Pi imports、SDK/session/resource lifecycle 和 native controls。`packages/reader` 只放可独立使用的 reader 状态与
呈现逻辑；不能把现有 DSH `EvidenceDeskView` 原样改名后称为已解耦组件。

## 3. 保持六种权威边界

1. 原始 source revision：不可变字节、hash 和来源。
2. 表征/index generation：PDF text/OCR/layout/tree，带 generator/config/source lineage。
3. Evidence 与事实推导：原文读取、支持/反驳/限定关系、计算活动；来源可核验不等于语义必然支持结论。
4. 研究资产：有证据链的已完成研究、Note、问题、决定、Review、已发布成果。
5. 个性化：如何理解、核验、组织和呈现；不能成为 Evidence 或弱化验证门槛。
6. 运行历史：Pi 会话/分支与 DocAtlas run/control 关联，不是以上对象的替代数据库。

关闭个性化不关闭旧研究；关闭跨文档 recall 不删除用户语言/布局偏好。Pi 上下文压缩也不能删除研究事实，
更不能把压缩摘要升级为原文证据。

## 4. 产品工作流不是强制流水线

普通编程/问答沿用 Pi 原生能力，不要求先绑定 PDF、建 Claim 或写 Note。文档问题使用 Search/Read 与精确
引用；Verify 才增加反证/范围/冲突检查；Publish 才执行完整 Review/sign-off。简单 Ask 不自动产生长期 Memory。

混合任务例：财报原文 → 提取数字 → 原生 shell 运行计算 → 图表/表格 → 报告。计算结果标为 derived，记录
输入 Evidence、脚本/环境/执行结果与 artifact hash。它不能冒充“原文写了这个数字”；生成文件也不能循环支持
其祖先 Claim。浏览器/网络材料进入另一个有 provenance 的 source 类型，不能假装是当前 PDF。

Note、Review、Memory 继续正交：无证据的 commentary/hypothesis 可以保存，但不是 accepted fact；Recall 只
带回 lead；Review 包括确定性检查、可观察的 Agent challenge 和人类裁决，不是简单搜索旧 Note。

## 5. 三棵树必须区分

| 树 | 含义 | 更新边界 |
|---|---|---|
| Pi Session tree | 对话分支与继续位置 | 由 Pi 原生 session API 管理 |
| Canonical document tree | 某版材料/表征的结构 | 不可变 generation；Flash 优化创建下一 generation |
| Working/Research/Personalized overlays | 已读范围、研究关联、用户视角 | typed journal/projection，可重建、撤回，不改原文结构 |

切换对话分支不回滚共享 Note/Claim/人类决策；新分支用显式 investigation/run binding 决定可见工作状态。
旧树 node_id 不能充当永久 Evidence ID。引用锚定 source revision + representation + selectors，索引升级需要
可验证映射；映射失败应 stale/ambiguous，而非跳到“看起来差不多”的段落。

## 6. 依赖、兼容和升级

- `contracts/` 和 `packages/contracts` 保持原位和现有 wire 字段；runtime identity 的新语义先走 contract review。
- Core 先提取近纯模块和已有 store；保持行为/tests 再做文件拆分，避免搬家同时改事务逻辑。
- 旧 DSH wrapper 在提取后调用同一 Core；不长期维护两份数据库/业务规则实现。
- Pi 通过公开 SDK/hooks 集成；必要的内部 hook bridge 可以存在，但业务不装进它的 closure/state。
- `.sources/pi` 是研究代码，不是产品 import 路径；将来发布依赖由 pnpm 精确锁定且单独验证。
- 子 Agent/后台任务是受管运行，不是私藏第二套 Python chat。所有任务有 scope、budget、cancel 和 lineage。

物理迁移、数据迁移和产品切换是三个不同动作，退出条件见 [迁移清单](../migration/dsh-to-core.md)。

## 7. 已接的本地人类研究工作面

[ADR-045](../adr/045-local-human-review-workbench.md)将`ProductReviews`作为host装配层，调用Core的`ClaimReviewApplication`
与同一`SourceScopeStore`/M4 journal。六个用户动作覆盖Claim保存/CAS、Brief或Matrix草稿、材料核对声明、G0–G4、
独立签署和本地Publish；不是新的Pi tool，普通聊天/编程无需经过此流程。

Core读取原Answer/selection中的Evidence、Locator及capture origins，验证精确原scope/身份/hash；host再检查原conversation、
source权限与Answer的私有completed checkpoint publication。Note/Recall/profile不是Evidence，prepared scope也不是已消费证明。
用户可在独立的人类workbench选择历史快照；这不改变native Agent的source admission，不将旧证据借给新的scope。

整条产品command hash连同真实用户进入既有幂等输入；Web只用原body/key对账。产品Publish看精确Review的最新journal-order
批准，已提交publication只可对账原receipt而不能借新key再发布。Core同时防止无效derived输入经accepted输出洗白，并在发布时再检查。
这些规则不等于语义/算术证明；个人记忆、研究连续性、自动学习和正式对外发布仍是独立能力与验收项。
