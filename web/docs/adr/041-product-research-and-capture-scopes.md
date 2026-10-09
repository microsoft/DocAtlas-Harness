# ADR-041 · Pi 研究记录、Notebook 与非准入来源快照

> 2026-09-09 · Accepted for the local beta · 不等于全部 R4 / Continuity / 发布验收完成

## 决定

复用 Core 的 Investigation journal、Record/Recall、SelectionAction 和研究 lifecycle，不另建一套笔记真相库。
Pi 新增 `docatlas_record` / `docatlas_recall`，保留全部原生工具与已有文档工具。模型只能记录未核验的 checkpoint /
open-question；用户 Note 编辑、归档、软删除与个人画像命令走独立认证 HTTP，不给模型 human sign-off 权限。

身份映射明确为：领域 `sessionId` / `sourceSessionId` = product conversationId；原始 Pi runtimeSessionId、submissionId、
native toolCallId 和 binding generation 存于私有 ResearchJournal。合法 wire callId / 幂等键由完整宿主调用身份派生，
不包含正文或可变 scope：同一调用改正文/换 scope 必须冲突，而非产生第二条记录。先保存宿主 provenance，再提交 Core
记录，最后保存 recordId 关联；成功 tool result 之前这些步骤必须完成。取消不能撤销已经提交的记录，但可以阻止送达。
这不是 Read attestation / checkpoint 语义支持证明；Research record 永远不能直接补入 Answer 的已读证据集合。

原文 scope 和研究 capture 都属于 Core，但存储明确分区：

- 已准入、非空的 submission scope 仍由 SourceScopeStore 持有，使用既有版本/字段。
- 无文档的研究任务，以及用户显式保存尚未用于提问的选区，使用 ResearchScopeSnapshots 的不可变 v1 capture。
  只存 SourceScopeVersion，最多 64 个来源身份，没有正文、representation 或 Evidence；不 bind DocumentSession，不修改
  当前准入 scope，不授予 Read 权限。两个分区同 ID 同时命中即拒绝。
- legacy source-scope RPC 的 `sources.minItems=1` 不放宽，不修改旧数据库 schema v5。普通 Pi 提交只准备内存研究 frame；
  真正调用获准的研究工具时才写空 capture，不能因研究保留容量阻断无关的普通 Pi 任务。
- prepare 不激活 frame；只有同一原生输入被精确消费后才安装。旧队列/取消/代际变化不能借用前一次研究或文档来源。

## 检索与原文

宿主授予当前单用户工作区的研究访问后，Core 在 FTS、数量和 cursor fingerprint 之前按来源/原会话权限过滤。
受限查询不使用包含不可见语料的全库 bm25 权重；只检索可见记录，稳定排序。旧源被撤销、替换或缺失时不返回缓存正文。
Agent checkpoint 的整个来源 frame 也参与权限检查，即使它本身没有 evidence locator。

Recall 只返回有界未核验线索；checkpoint 可附其关联的来源候选，但明确不证明曾读过这些来源。关联 metadata 也计入
整体预算，必要时减少返回条数并保留正确 cursor，而不是删掉来源身份。纳入旧源、重新 Read 和新事实支持仍是后续独立步骤。

用户从已核验 selection ticket 显式保存 Note：复用 SelectionAction/Locator/EvidenceAtom，记录作者是真正的 paired actor。
Note 正文仍是解释/假设，不因引用位置可定位就成为事实。保存不消费问题 ticket，也不改变 Agent scope。
Notebook 的列表是 bounded preview；编辑必须先读完整正文，再以 expectedVersion 做 CAS。软删除撤下当前投影，但保留历史，
不能称为隐私擦除。原文按钮只接受已保存 noteId + locatorId，重验权限/原件/唯一 quote，共用 ADR-039 的 resolver 和实际 shutdown join。

`product-research.v1` 规定新浏览器命令/结果及私有 provenance 的形状。路由严格限定公开 kind；schema 接受私有对象不等于
浏览器有权提交或读取它。未确认写入保留标签页原键，刷新不自动重放。研究 recall/contribute 两开关独立于个性化开关；
它们约束 Agent，用户明确的手动保存仍可执行。

## 尚未关闭

完整 Question/Decision/Policy 工作面、Claim/Review/Publish、跨版本 Continuity、无选区的用户自由笔记、独立于问题托盘的
选区保存入口、异常主机退出后的跨库 pending provenance 对账、批量删除/隐私擦除/备份恢复与真实业务质量仍需后续工作。
当前实现/准确验证记录见[任务板](../execution-tracker.md)，不以字段冻结或 fixture 数量宣称全部 R4 完成。
