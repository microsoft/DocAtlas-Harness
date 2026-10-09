# DSH → DocAtlas Core 迁移清单

> 2026-09-09；保留已有产品设计和实现资产，不以原版 DocAtlas 重新开始。
> 状态：Core stores/document/研究/偏好应用、人类Claim/Review与显式版本/Continuity产品工作面已接，复用原证据、Library与研究journals；Node基础设施独立为runtime-document。未迁用户数据库，完整code/data/product gates仍分开。主执行顺序见[计划](../implementation-plan.md)。

## 1. 四种处理方式

- **保留原位**：contracts、Python document service、downstream checkout 等已有明确边界。
- **提取复用**：业务规则/store/state machine 移入 Core，原 tests 随行为保留。
- **拆适配器**：业务不变，把 DSH event/type/Connection/Cordis 依赖移出。
- **重做入口/呈现**：Web shell、composer、auth/stream 和失配交互按产品设计重新组织；不复制 CSS 隐藏方案。

任何“旧实现存在”不等于“新产品已通过验收”。迁移一次只改变一类边界；先验证等价，再优化行为。

## 2. 代码与能力去向

以下源路径若无其他说明，均相对 `plugins/docatlas-dsh/src/`，描述迁移输入。首批 5 个存储/纯模块已移入
`packages/core/src/storage/`（保留原内部模块分组），源路径只剩 re-export；其余目标仍是规划，详见本页末尾。

| 资产 | 当前实现 | 处理 / 目标 | 迁移验收 |
|---|---|---|---|
| wire/durable schemas 与 TS/Python binding | 根 `contracts/`、`packages/contracts/` | 保留；新增 runtime contracts 单独 review | 字段/版本/hash 不静默改变；共享 valid/invalid fixtures |
| SourceScope、Library、Investigation journal | `source-scope-store.ts` | 已提取到 `packages/core/src/storage/`；ADR-052另行评审人类研究v5→v6同库增量升级 | 原bytes/哈希、CAS、FTS、backup-first、unknown receipt；不是迁移实时用户数据 |
| Claim/Review/Artifact | `investigation-m4-store.ts` | Core/storage+ClaimReviewApplication；ProductReviews+product-review v1+live Reviews接六个人类命令 | 原M4 journal/CAS/G0–G4、精确历史工作面/原Evidence/独立签署与本地发布；实际HTTP/Pi/browser定向链通过，完整业务/恢复/发布验收仍待 |
| Continuity store/service | `investigation-continuity-store.ts`、`continuity-service.ts` | Core/storage保留canonical journal；ProductContinuity/product-continuity v1/Live Continuity接人类工作面 | 完整Answer/selection/derived闭包、原Note capture adapter/出版授权、双侧Read/PDF核验、record version与整body幂等；完整业务/恢复待验 |
| Personalization | `personalization-store.ts` | store保留Core/storage；Core controls/application、host临时模型policy与Web v2 | 双开关/CAS/forget/export和bounded decision/实际生成use已接；不改native消息/Evidence；自动学习/Probe/真实模型事实对照仍待 |
| Answer compiler | `answer-manifest.ts` | Core拥有纯编译器，DSH薄adapter；ADR-039新增宿主Read凭据与Pi checkpoint投影/原件引用 | ID/hash/16-citation显式gap保留；真实Azure合成PDF闭环通过。复杂geometry/compaction/steer归属与全质量验收仍待 |
| Answer/tool projections | `answer-projection.ts`、`projection.ts`、`projection-types.ts` | 保留 legacy reducers；新 Pi projector 在 `runtime-pi` | native event ordering、checkpoint/cold replay、无第二事实源 |
| Scope admission/overview | `source-scope.ts`、`source-scope-overview.ts` | 核心策略 + runtime actor/run port | 新会话/旧会话/queued message scope 一致，先权限后检索 |
| Library ingest/discovery | `library-service.ts`、`library-discovery.ts` | 已提取Core use case + runtime-document filesystem adapter | opaque candidates、同名消歧、dedupe/revision、取消/恢复 |
| Selection transactions | `selection-service.ts` | Core stage/claim/commit + Pi message adapter | all-or-none、重试/撤销、选区不能附错队列消息 |
| Search/Read/Record/Recall adapters | `tools.ts` | Core document/ResearchOperations与Pi ToolDefinition/facet已接；私有journal保留原生调用归属 | 原生工具不覆盖；bounded text/details；查询前权限；Record不是Evidence |
| Sidecar supervisor | `sidecar/supervisor.ts`、`sidecar/spawn.ts` | 已提取runtime-document；Node/DSH分别适配同一process port | 双lane/backpressure/recovery；新late-spawn取消回归；完整隔离未过 |
| Authenticated assets | `assets.ts`、`asset-url.ts` | 资产策略复用；product route/URL 重做 | opaque IDs、Range/ETag、rev/hash、访问撤销、no raw path |
| Browser/RPC/exports | `browser-channel.ts`、`rpc-channel.ts`、`personalization-export*.ts` | typed commands 复用，Connection 替换为 product transport | auth、actor provenance、CAS、可撤销下载、无 token 泄露 |
| Host composition | `index.ts` | use cases 到 Core；composition 到 `apps/server` | 不把 Cordis Service 改名后搬进 Core；依赖方向可检查 |
| PDF focus/Compare/selection model | `client/EvidenceDeskView.tsx`、`focus-registry.ts`、`selection-directory.ts` | 新Web ReaderNavigation/CompareReaders接A/B独立位置/返回栈；共享Reader package物理提取仍待 | original PDF highlight、dual cursor、同名不同版、selection不串源；完整geometry仍待 |
| Library/SourceScope/Answer sources UI | `client/LibraryAction.tsx`、`SourceScopeAction.tsx`、`AnswerSourcesAction.tsx` | 行为模型复用；入口/布局重做 | all submission paths、精确引用、草稿保留、多文档状态 |
| Heavy research UI | `client/ResearchWorkspaceView.tsx`、`ClaimLedgerPanel.tsx`、`ReviewPanel.tsx`、`PublishPanel.tsx` | Notebook已接；新live Reviews/review-state按需承接Claim/Brief/Matrix/G0–G4/签署/本地Publish，不复制旧DSH布局 | 原scope与未知请求body/key冻结，原件focus，最新journal顺序批准；不自动升级Note为Evidence，完整工作流/数据迁移验收仍待 |
| Continuity/Personalization UI | `client/ResearchContinuityPanel.tsx`、`PersonalizationCenterPanel.tsx` 和对应 models | 复用状态模型，重做 product access | why-used、scope、pause/forget、旧研究 reverify，不把偏好当证据 |
| Chat-first landing/preflight | `client/ProductLanding.tsx`、`product-source-preflight.ts` | 保留 intent/测试；admission 移到 server 所有入口 | 不再只保证 landing；resident/selection/retry 同样可用 |
| DSH CSS/slot masking | `client/product-ui.ts`、`client/index.ts` | 仅留 legacy；不进入新 Web | 不依靠隐藏宿主工具/权限/开发区造产品 |
| Progressive Python read/index/render | 根 `python/docatlas-sidecar/src/docatlas_dsh_sidecar/` | 保留可运行路径，名称后续再迁 | read 五 mode、Locator、index generation、PDF geometry、protocol |
| 原生 DocAtlas 文档实验 | 根 `DocAtlas-Harness/` | 继续独立 Git 下游；按服务能力迁移 | 不丢 Search/tree、visual、Note hooks 研究；不重新引入旧隐藏 loop |
| Flash | `.sources/pageindex/pageindex/flash/` | 新可选 index provider；不是直接覆盖 vendor | text/mixed/scanned quality、worker bounds、generation、no hidden LLM |
| 测试与评测 | plugin tests、`e2e/`、sidecar tests、`evals/` | 保留基线，按模块迁/扩充真实 Pi/Web tests | 不以 fixtures-only 浏览器通过代替真实主流程 |

## 3. 旧计划到新计划的完整对应

| DSH 工作包/讨论 | 新阶段 | 明确保留的重点 |
|---|---|---|
| F0 / X0 | R0/R1/R7 | 固定环境、上游来源、下游补丁/回归、升级/回滚 |
| M0 | R1/R2 | source/revision/representation/Locator/Evidence，跨语言 parser 和稳定身份 |
| M1 | R2/R3/R5 | supervisor、ingest、FTS/tree、五种 Read、bounded visual、原始资产、real model loop |
| M2 / UI0–UI3 | R3 | chat-first、PDF-only citation highlight、Library/scope、selection、Compare、dual cursor |
| M3 / UI4 | R2/R4 | typed Note/Question/Decision/Policy、Recall、Notebook、Working/Research Tree overlays |
| M4 / UI4 | R4/R6 | 原子 Claim、反证/冲突、计算推导、G0–G4、Review、sign-off、Brief/Matrix |
| M5 / UI5 | R4 | 跨 session 已完成研究积累、旧文档 re-admission/reverify、新版本影响 |
| K0–K4 / M6 / UI6 | R2/R4 | 个性化闭环、单变量 Probe、why-used、pause/edit/forget/export、non-interference |
| M7 / UI7 | R5/R8 | Flash 提前；OCR/layout、provider、Series、Studio/Timeline、团队/同步分阶段 |
| 原生 Pi 全能力与通用 Agent | R1/R6/R7 | native parity、Skills/扩展、分支、工具、受管多 Agent、编程/分析混合任务 |

旧三栏强制布局、DSH-only 顶层导航、document-only 工具 preset 是已被用户最新要求替代的实现选择；领域能力
没有被删掉。低优先级云/协作/Studio 仍列为 deferred，而不是从计划消失。

## 4. 三个独立迁移 Gate

### Code gate

先提取 contracts-compatible stores/纯逻辑，旧 DSH wrapper 继续通过原 tests。再拆 runtime/service ports，最后
迁 Web model/view。一个阶段不同时改文件位置、数据库 schema 和事实准入算法。新目录不 import 旧 plugin 来
伪装解耦；旧 wrapper 可以单向依赖已提取 Core。

### Data gate

本次不移动 DB、blob、sessions，不改 domain IDs/hash。R2/R7 在拷贝样本上验证 backup-first migration、同名
workspace/profile 冲突、source revisions、WAL、backup/restore、artifact lineage 和个人记忆删除语义。

DSH transcript 暂作只读历史 provenance；不能把其 event JSON 改字段名后当原生 Pi session 导入。需要新的
runtime-binding 映射和历史访问策略。确认权限之前不会自动把旧来源加入新调查，也不自动搬运所有用户画像。

### Product gate

至少通过：首次上传→问答→PDF 原文高亮→selection 追问→native code/计算→取消/刷新恢复，以及跨文档
Note/Claim/Review/Publish、Continuity 和个性化控制。没有这些验收，不切默认 launcher，不撤 DSH 回退入口。

## 5. 本次目录整理的实际边界

以下记录的是 R0 重组时的边界。D0 原型新增情况见下一节，不回写历史迁移完成度。

- 已将旧计划/任务板复制到 `docs/archive/dsh/`，保留细节和历史测试记录，修复归档相对链接。
- 活跃主计划/任务板重新表达新目标；architecture/product/migration 文档分职责。
- 新 apps/packages 目录只有明确的职责 README；尚未创建虚假的启动脚本、空 API 或通过不了集成的假实现。
- `plugins/docatlas-dsh`、Python 包、contracts 和独立 downstream Git checkout 都保留原位。
- 工作区仍是 `DocAtlas-dsh/`；不重命名根目录，不修改任何 sibling `DocAtlas-Pi`/原始 DocAtlas 项目。
- 当前外层目录没有独立 `.git`，在父仓库中作为未跟踪目录存在；本轮不初始化新仓库、不 stage/commit，也不影响
  已独立版本化的 `DocAtlas-Harness/`。正式发布前需明确父仓库纳管还是独立产品仓库，不能用广域 git add 自动决定。

## 6. D0 原型优先更新（2026-09-08）

apps/web 现在是独立可运行的交互 Demo，使用现有样例原始 PDF 字节和 PDF.js；原型回答/进度为预设，文件/笔记/
偏好仅在页面内存，不连接 Pi 或任何已有领域数据库。新增 package/lock、静态认证预览、prototype unit/browser
tests；没有从旧 plugin 搬迁运行代码，也没有将临时 QuoteContext 改为正式 Locator 契约。

按照 [ADR-022](../adr/022-prototype-first-delivery.md)，用户已确认首轮原型并允许开始后端；
[后端详细设计](../architecture/backend-delivery.md) 将 R1 技术验证/合同与 R2 提取排成可执行队列。
后续重模块在各自实施前评审。Prototype Reader 不是本表的生产 Reader 提取完成，模拟答案也不构成 Agent/Evidence gate。

## 7. 首批 Core extraction（2026-09-08）

source-scope-store、investigation-m4-store、investigation-continuity-store、continuity-service、personalization-store
成组移入 `packages/core/src/storage`；共 9,465 行，移动时逐文件 SHA 不变，不同时拆表/改 schema/优化算法。
5 个纯测试移入 `packages/core/test`，修复原先未纳入 typecheck 的两处 test-helper 类型问题；新增 ownership tests。
plugin 通过 `@docatlas/core/storage/*` re-export 保持原 API，单向依赖 Core，发布构建继续打包同一实现。
数据 gate 未开始：现有 DB、blob、sessions、profile、source IDs 都未移动。完整 checksum 与实验记录见 research/19。

## 8. 第二批 document extraction（2026-09-08）

LibraryService/source-scope → Core/document；LibraryDiscovery/assets/asset-url/supervisor → runtime-document。
旧paths为薄re-export；DSH/Cordis、browser Connection和DSH spawner仍在legacy adapter。未复制存储、未改领域wire/schema。
新增DocumentSession/Operations和server DocumentApplication，将现有Library/Python实现连接Pi additive tools。
独立Read/Tree/Image身份检查、prepare/consume隔离、per-conversation cancellation及late-spawn修复不是“仅移动文件”。
SourceScopeStore仅增加历史representation/当前scope的读接口。证据和仍未关闭的部署/安全问题见research/23。

## 9. Product selection tickets（2026-09-09）

Core新增 `document/selection-verifier.ts`，复用既有read-page/resolve与Locator合同，核验排版空白映射和原文字符位置。
产品selection ticket生命周期放在server私有控制库，不把旧DSH SelectionService的nonce/turn-step/事件扫描搬进Pi。
旧selection-service与markers不变；没有迁移或复制既有用户selection-action/Evidence journals。live提交通过Core
DocumentSession的SelectionAdmissionPort接入，source frame仍只在精确native consumption后激活。参见ADR-037/research32。

## 10. 人类Claim/Review产品集成（2026-09-09）

[ADR-045](../adr/045-local-human-review-workbench.md)在既有Core提取上接`apps/server/src/documents/reviews.ts`、
`contracts/runtime/product-review.schema.json`与`apps/web/src/live/Reviews.tsx`/`review-state.ts`。
复用原M4命令/记录/规则和原Answer/selection证据，不新建Evidence、Claim、Review或发布数据库；没有迁移DSH用户数据或改写旧provenance。

SourceScopeStore新增原scope、Answer和M4状态的私有只读枚举与精确canonical Evidence访问；底层M4 resolver可接
原Investigation/scope上下文，旧单参ports仍兼容。Core人类应用增加可选整条product commandHash，旧caller省略时保留原幂等输入。
新的host重新建立认证用户、原conversation、source与completed Answer publication权限，不复用DSH Connection当产品身份。

工作面显式选择历史scope不更新native准入或selection消费。产品要求最新journal-order批准后本地Publish，但原publication
可原body/key对账receipt；此产品策略不反写旧DSH签署语义。新UI保留未知结果的原请求，不自动重发或把旧请求改到新scope。
Code集成与定向HTTP/Pi/browser链已有记录；完整business/recovery/全部browser验收、Continuity与backup-first data gate仍未完成。

## 11. 显式版本与Continuity产品集成（2026-09-09）

[ADR-046](../adr/046-explicit-revisions-and-continuity.md)继续复用Core Library和Continuity journal，不创建第二份版本/Evidence/研究数据库。
`LibraryImportRequest.revisionTarget`为可选增量；旧请求保持原意。`ProductLibrary`/`product-library`协议与`VersionHistory`界面
提供同document CAS更新、不可变bytes、历史原件及只读原请求status。历史revision malformed superseded投影只按经过验证的旧shape/真实链
在内存补全successor，新写入完整；不改旧磁盘blob/hash，不迁移用户数据。

`ProductContinuity`/`product-continuity`协议与`Continuity`界面重建产品身份和原研究权限，Core增加完整依赖/Answer Evidence解析及
受限读取接口。旧原生scope与ResearchScopeSnapshots仍分区；笔记走原Notebook授权adapter，正文不成为Evidence。
Core request/link增量可选`priorRecordVersion`，新产品强制版本固定并将完整body hash纳入既有journal幂等；旧caller保持兼容。
比较使用真实completed Answer scope、新Read双侧Evidence与原PDF解析，不更新旧Claim/Artifact/出版内容或Pi来源准入。
第二十一批增加可选trusted Library completion：原document/alias/record receipt/job成功同事务，不变旧record input hash；旧孤立receipt仅显式原键修复，status不写。
代码/产品集成不代表完整host crash监督/硬件掉电、历史数据迁移、全业务和公开发布已验收；准确结果见任务板第二十/二十一批。

## 12. 受控呈现学习（2026-09-09）

[ADR-047](../adr/047-controlled-presentation-learning.md)沿既有Profile DB与Personalization journal连接Probe→Choice→Observation→pending Candidate→独立review→MemoryVersion。
新增`core/personalization/controlled-presentation.ts`、`server/personalization/probes.ts`、`product-probe`协议及Web `Probe`/`probe-state`；
复用现有Answer compiler/private publication、Profile读写/擦除代际、偏好应用与原PDF citation handler，不引入新loop/Evidence或记忆数据库。

Core存储增量提供guarded Probe与原子Choice批写/严格内部receipt/只读getters，原API仍兼容；review command可选完整product hash及事务内同步授权。
非空Claim Probe原语义不变，schema新增允许真实空Claim集合，旧binary可能拒新case，应跟随新product能力发布而非发送到未升级宿主。
导出JSON/Markdown补未晋升可导出候选/选择但保持reference-only与删除过滤；没有迁移用户Profile、修改现有record IDs或开启自动习惯推断。

## 13. 原生控制与历史阅读（2026-09-09）

[ADR-048](../adr/048-native-operations-and-history-pages.md)增加runtime-pi原生settings/proof/bootstrap和host NativeOperationStore/统一调度/只读历史分页。单独操作库在既有private control root，不迁移ControlStore v1，不保存第二份transcript；冷未决对账不运行SDK/factory。Pi格式与24文件补丁保持，原DSH Session事件/RPC不变。

Web的运行设置/原键待办与历史滚动窗口只绑定已授权原生ID；旧Answer/PDF仍走原publication/Evidence/Locator。原始用户正文通过精确ControlStore checkpoint关联取回，unknown/purge不回填prepared注入；研究/个性化stores、原型与用户数据均未搬迁。完整compaction/fork/跨边界出处、无损旧数据迁移与公开发布不因此完成。

第二十三批[ADR-049](../adr/049-manual-native-compaction.md)在同一个Pi native session追加真实手动compact记录与终态证明；已证未应用用独立failureProof，不改旧成功result语义、不新增ControlStore DB schema。旧Answer出版/原件、Note/Review/Profile原位保留；自动in-turn compact与分支迁移未由此解决。文档sidecar仅query-time补有界中文子串匹配，旧FTS数据库/索引generation/canonical tree/上游vendor不改；打包副本通过既有同步脚本更新，不手工分叉。

## 14. 原生分支与Flash标题优化（2026-09-09）

[ADR-050](../adr/050-native-lineage-handoffs.md)使用Pi实际selected head/navigation/fork和父子原生文件证明，Catalog v2增加独立交接journal与历史binding；受检v1→v2升级保留旧行/seal，活跃claim或未知schema不被清除。测试使用临时数据库，不运行用户数据迁移。
ControlStore表结构、原Answer/Evidence/Note/Review/Profile不迁移或重标。history/Answer wire仅增加可选selectedHead/origin，旧v1兼容；新host按原始publication、会话权限与source权限重建引用。DSH Session事件与旧RPC保持不变，Pi24文件补丁不变。

[ADR-051](../adr/051-flash-numbered-heading-guards.md)通过reviewed exact-hash生成器加入有限编号标题guard，而不是手改vendor或升级官方pin。已有index generation保持不可变，新provider fingerprint产生新代索引。复用既有打包同步与provenance检查，不另建Flash/sidecar实现分支；同PDF配对和反例改善不等于全语料/OCR/正式发布通过。

## 15. 独立人类研究与同库v6（2026-09-09）

[ADR-052](../adr/052-human-research-authoring.md)使用既有SourceScopeStore和`journal_events`，增量增加`human_research_records`与`human_research_commands`投影。后者只保存整请求hash/原操作/版本等最小回执，不复制研究正文。Governance保留旧wire，其人类命令及原来源四元组存于同一canonical事件的私有metadata。旧Agent/Selection/Governance记录不重标、不伪造作者或Evidence。

v5库首先完成checkpoint并以独占文件复制、权限和完整性检查建立`backups/migrations/<workspace-hash>/schema-v5-*.sqlite3`，再以事务建表/更新v6；失败回滚并保留备份。测试验证旧record bytes/hash、重开和被篡改的降级拒绝；v6不能交给仅支持v5的旧程序。实际开发只操作临时测试数据库，不启动用户库的升级，不删除或迁移旧DSH状态。这个领域备份也不是整套产品恢复包。

新的`human-research.v1`、host `HumanResearch`及Web独立工作面与旧`product-research.v1`/selection/Agent工具并存。新建人类Note/Question及Governance之后，任何入口的后续变更都必须携带可信commit context与同事务回执；旧入口不能绕过。保存PDF选区直接核验原文而非复用Ask票据；锚点/只读overlay是导航关联，不产生Evidence、不修改canonical tree、Pi历史或个人画像。完整研究/数据迁移/异常恢复仍由R4/R7另行验收。

## 16. Flash recipe与偏好学习（2026-09-10）

[ADR-053](../adr/053-bounded-parallel-flash-enrichment.md)只为新增强请求增加显式recipe版本：缺省/旧排队请求和回执仍为v1，新Web提交v2；独立overlay/result/page接受各自版本，同键换recipe冲突。没有迁移原tree、FTS、PDF或已有增强结果，也没有更新上游pin/vendor。

[ADR-054](../adr/054-consented-preference-learning.md)复用同一个PersonalizationStore/journal，以metadata v2→v3的先备份升级引入reference-only邀请/选择/学习回执与派生查询索引。保留原profileEpoch、旧行/哈希/单次Probe语义；旧程序必须拒绝新版本，v2以上缺失epoch不能重置为0。测试使用临时profile验证备份、失败回滚、擦除、导出和原键恢复；并非迁移实时用户数据。

新的product-learning接口和按需学习面板并列于旧product-probe，而不是重写过去的选择。早期null候选回执不回填；新候选只来自三项独立研究的明确同向选择，并须独立确认。跨任务组的相反票、原文不可用、旧入口绕过以及忘记后的旧票复活均受Core保护。邀请不算偏好反馈，profile不复制原PDF/Answer/Note正文，Pi transcript和研究domain不迁移。
