# 后端设计与落地顺序：从已确认原型到真实 DocAtlas

> 2026-09-08 · Backend design v1 · 对应主计划 v0.6 的 R1–R7。
> 用户已确认 Prototype 01 可以定稿，并要求开始后端。本文是详细实施设计，不是后端完成声明。
> 工程合同需按 [ADR-023 提案](../adr/023-product-backend-control-plane.md) 和下述 spike 验证后逐项冻结。
> 实施更新：公开 Pi SDK/初始组合、10 个 runtime/isolation 实验、首批 5 个 Core 模块提取已落地；完整 gate 尚未通过，见 [执行记录](../../research/19-backend-runtime-spike.md)。
> 第二批：内部提交信箱、product-control v1、原生 checkpoint 与真实 crash 恢复已通过有限验收，见 [ADR-024](../adr/024-durable-product-submissions.md) 和 [实验记录](../../research/20-durable-inbox-and-flash-probe.md)。HTTP/完整隔离仍未接入。
> 第三批：真实调度/heartbeat/queue与Linux原生I/O已实现，SDK补丁进入fingerprint gate；全路径安全/HTTP/文档仍待做，见 [ADR-025](../adr/025-native-io-and-submission-dispatch.md)。
> 最新有界实施（2026-09-09）：loopback Pi Web/Read引用、研究/偏好、Claim/Review/Continuity与单变量Probe，以及原生设置/历史分页已接（ADR-039–048）。早期候选/实验不回写为生产保证；当前完成度与最终check/browser以[任务板](../execution-tracker.md)第二十二批为准。

## 1. 先交付什么

第一条真实闭环：**上传自己的 PDF → 真正提问 → 流式回答 → 点击出处打开原始 PDF → 选区追问 → 刷新后继续。**
与此同时，没有 PDF 时能正常执行 Pi 的代码/文件任务，不出现“先绑定 Source Scope 才能工作”。

原型的视觉与主要交互已确认；生产接入需要补准备/失败/授权/断线等真实状态，但不重做首页布局。
多文档、研究连续性、Review/Publish 和个性化仍在完整计划内，不把它们简化掉，也不等所有重模块做完才让主链可用。

初次设计时的边界为文档与源码核对。随后的持续实施已提供真实本机Pi Web和合成PDF的Azure连通性验证，
但未迁移用户数据库或通过完整生产验收。以下早期目标/候选方案的当前完成度以任务板和运行证据为准。

## 2. 运行形态：一个产品服务，受控执行进程

```text
同源 DocAtlas Web（现有原型的正式数据接入）
    │ HTTP commands / SSE observations / 原始 PDF bytes
DocAtlas Application（apps/server；认证、协调、投影、恢复）
    ├─ Core（documents / evidence / research / personalization）
    ├─ Runtime coordinator → 受限 Pi worker（完整 AgentSession）
    │                         └─ 原生工具 / Skills / trusted extensions
    ├─ Model broker（服务内模块；凭据、授权模型调用、用量）
    └─ Python supervisor → 文档 sidecar（解析 / 索引 / Read / resolve）
```

- 不复制 Pi loop，不运行第二个 Python 对话循环，不引入 DSH Web。
- 先做模块化单体 + 本机 worker；不用 Redis/Kafka、微服务编排或通用插件市场作为第一版前提。
- 初始部署按单用户、私有工作区、loopback + 端口转发设计；多用户/公网/团队 ACL 不在首个版本中默认开放。
- 产品 HTTP 层优先使用 Node 原生 HTTP 与已有 contract validation，保持有界路由表；上传用原始字节流，避免手写 multipart 解析。
- Pi 的进程边界服务于取消、崩溃恢复和 native 文件权限，不把业务规则藏进 worker。

进程隔离/模型桥接是首个技术验证项，不是已经成立的安全保证；详见 §8。若公开 SDK seam 不足，先报告具体缺口，
评审最小 adapter/patch，不以关闭原生工具或运行无隔离 shell 作为自动回退。

## 3. 目录与依赖

以下为目标路径；未建的目录仍是规划，代码按工作包逐步加入。

```text
apps/server/src/
  composition/         装配、配置校验、启动/关闭、能力检查
  auth/                登录会话、CSRF/Origin、workspace/asset 授权
  transport/           命令路由、SSE、快照、错误映射、限流
  runs/                submission/run 协调、幂等、恢复、审批队列
  documents/           上传落盘、准备任务、来源准入、sidecar 适配
  assets/              原始 PDF / 导出资产的受权读取
  execution/           worker 启停、隔离、IPC、model broker
  storage/             产品控制库、迁移/备份/恢复适配
packages/core/src/
  documents/ evidence/ research/ personalization/ workflows/ ports/ storage/
packages/runtime-pi/src/
  session/ tools/ resources/ controls/ projections/ model-bridge/ worker/
packages/reader/src/    正式 Reader 状态、身份与 geometry 映射
apps/web/src/
  ...现有视图...
  data/                Demo driver 与 Product client 的显式隔离
contracts/product/     评审后的新产品合同；不是现有 v1 的原地替换
contracts/fixtures/product/
python/docatlas-sidecar/  保留现有包、uv 与协议；只改所需 document 能力
```

依赖规则：Core 只依赖 contracts/Node 或其声明的 ports；不依赖 React、Pi、DSH、server。
Pi imports 只在 runtime-pi，server 通过公开 adapter 装配。旧 DSH wrapper 可以依赖提取后的 Core，新 Core 不反向 import plugin。
不再制造一份 store 复制品长期维护；首次提取允许把紧耦合的旧 store 模块作为一组保留，之后才重构内部文件。

## 4. 现有能力怎么继承

| 现有实现与本次核对结果 | 后端处理 | 不能直接复用的部分 |
|---|---|---|
| SourceScopeStore v5 依赖 contracts/Node，内部调用 M4/Continuity | 成组提取并保留迁移/CAS/FTS/backup tests | 文件移动时不同时拆数据库或改 schema |
| LibraryService 引用 DocAtlasRuntime | 提取准入/准备 use case，注入 document/storage ports | Cordis Host、DSH session/browser 判权 |
| SelectionService 用 DSH UserMessage，stage/claim 在内存 | 保留 all-or-none 规则；新产品 admission 持久绑定提交 | DSH 消息标记、turn/step lease、按 session hash 构造 user actor |
| Answer compiler 从 DSH SessionEvent 按 turn 收集 Read locator | 拆纯编译器与各宿主输入 projector | DSH turn 不能直接当 Pi run；现有限额不能静默裁掉长回答出处 |
| M4/Continuity/Personalization stores 与契约已存在 | 按各自领域迁移，继续跑原行为回归 | 新产品身份、权限、执行 provenance 需显式映射 |
| Supervisor 生命周期较独立，但 handle/spawn 依赖 DSH subprocess | 抽出窄 ProcessHandle，服务端实现 uv 启动/关闭 | DSH subprocess 类型及隐含环境 |
| Python Read 五 mode / resolve / 原 PDF geometry 已有 | 首个文档基线直接复用并做真 PDF 对照 | 不能承诺所有 Markdown/OCR 片段均能精确对齐 PDF |
| Prototype PDF.js、样式和交互已获认可 | 保留交互，接正式 source/Locator/selection 客户端 | fixture CITATIONS、脚本回答、临时 QuoteContext 不进生产事实路径 |

完整清单见 [迁移表](../migration/dsh-to-core.md)。DSH 数据和 transcript 保留原位，新产品先用新 data root；
只在复制样本上验证历史导入，不自动搬用户画像、源文件或历史会话。

## 5. 五类状态不能混成一个 Memory

| 状态 | 权威与建议存放 | 恢复语义 |
|---|---|---|
| 会话 | Pi 原生 JSONL session tree | Pi 恢复/分支 API；产品记录绑定，不复制成另一套聊天库 |
| 产品控制 | control.sqlite：提交、run、binding、审批、job、checkpoint | 幂等命令与恢复对账；不作为研究事实来源 |
| 文档与研究 | 复用 workspace Investigation SQLite、不可变 blob | revision/Locator/Evidence/Note/Claim/Review/Artifact，不随压缩消失 |
| 个性化 | 独立 profile ledger | consent/版本/decision/use/纠正/忘记；不能支持事实 |
| 可重建内容 | 文档索引、表征、浏览器投影缓存 | 有 generation 和来源；可重建不等于可丢原件 |

服务配置显式指定私有 data root，权限默认目录 0700、文件 0600；路径不从浏览器获得，不落在可被 native tools 写入的项目区。
Pi sessions、数据库、模型凭据均不向 native shell 挂载；项目代码/产物与授权来源分别提供 RW/RO 区域。
SQLite 模式/备份/故障语义要验证；“同步 append”不是 fsync/机器掉电安全的同义词。

身份至少区分 actor、workspace、investigation、conversation、Pi session/branch、runtime generation、submission、run、tool call。
这些是待审的概念，不是本页偷偷新增的 JSON 字段。产品 user actor 来自登录会话，不从客户端 actorId 或 sessionId hash 推断。
同一 conversation 单 writer；第二个 Web tab 可以观察，竞争写必须协调；原生 CLI/TUI 访问同一个 transcript 需要显式交接。

旧 v1 的 sessionId/turn/seq 与 DSH provenance 原义保留。新 binding/DTO 采用独立命名空间，优先引用未改变的领域对象。
如果某个 v1 对象无法正确表达 Pi 来源，则加版本化的新对象/映射并带 migration fixtures，禁止把 Pi 字段塞进去伪装兼容。

## 6. Web 与后端的接口按用户动作设计

首版推荐 **HTTP 命令 + 单路 SSE 观察 + HTTP 快照/资产**，不同时实现 SSE/WS 两套运行协议。
SSE 不是后台 loop 的同步 listener；浏览器慢/断线不会阻塞工具完成。

| 用户动作 | 后端责任 | 界面得到的结果 |
|---|---|---|
| 打开应用/继续聊天 | bootstrap、认证能力、conversation snapshot | 正确历史、当前 run、模型、选中资料；不是 fixture fallback |
| 上传 PDF | upload slot → 有界字节流 → 校验/hash/原件提交 → ingest job | 已接收/可阅读/可检索/失败分别显示 |
| 选择资料或 @资料 | 基于 opaque ID 的 admission | 来源准备/scope 可用；不让用户处理内部绑定术语 |
| 发送问题/选区/后续消息 | 统一 SubmissionService，幂等、版本与选区校验 | 明确已接收/排队/执行/失败，保留草稿和片段 |
| 点击出处 | 当前授权、manifest/Locator、原件身份、resolve | exact/page-only/ambiguous/stale 等真实状态 |
| 停止 | 协调 Pi、Bash、sidecar、审批/子任务 | 请求停止与确认停止分开，显示部分已提交结果 |
| 调整模型/分支/上下文 | Pi 原生 control adapter | 真实能力与状态；切换不得沿用失效 worker 句柄 |
| 保存笔记/偏好 | 独立用户命令与领域事务 | 真实保存 receipt；不是拿聊天说“已记住”当成功 |

候选接口组为 bootstrap/conversations/submissions/controls/uploads/documents/reader/selections/research/preferences。
最终 method/route/JSON 在 R1 的 schema/fixture review 中签定；不照搬 DSH RPC envelope 或暴露任意后端方法名。

传输约束：

- 同源 HttpOnly session cookie；远程 HTTPS 开 Secure；bootstrap secret 只用于一次兑换，不放进 SSE/PDF URL。
- mutation 验证 Origin 与 CSRF；SSE、Range、预览摘录、导出同样认证；无任意 CORS、任意 path/URL fetch。
- 上传初始沿用 25 MiB/file，设置总 quota、并发、空闲/总超时；流式检查声明和实际长度，不把 PDF/base64 塞 JSON。
- 草稿只清到“提交已被持久接收”的边界；失败时附件/选区可重试。上传从浏览器本地读取变成发送到私有服务时必须明确提示。
- 观察序号按 conversation + generation，带 checkpoint；live delta 可合并/丢弃，缺段拉快照，不把重连当自动重新执行。
- HTTP 202 只表示持久接收；普通配置读取可 200；业务冲突/无权限/限额/版本不支持各有 typed error。
- 路由、body、返回、队列与 SSE 缓存均设上限；错误不下发绝对路径、stack、env、凭据或隐私上下文。

## 7. 接收、执行和保存是三个不同结果

首选方案：**持久提交信箱 + 明确运行意图 + Pi 原生 transcript + 可核验 checkpoint**。
不直接 monkey patch SessionManager 私有方法，不插入假 assistant 消息催生文件。

```text
用户发送
→ 有界校验/确认准入意图 → 持久提交信箱（可确认“已接收”）
→ 准备资料/版本校验 → scope snapshot + 全部选区绑定
→ 记录 dispatch intent → 调用 Pi → 模型/工具执行
→ Pi 真正 settled + 领域事务结清 + transcript checkpoint
→ 确认“完成并保存”
```

持久信箱暂存恢复所需的用户输入与选择引用，而不是只存一个无法重建问题的 hash。控制库中的 payload 是短期恢复副本，
不是第二个长期会话历史；checkpoint 后按 retention 清理，审计仅留必要 ID/hash/receipt。涉及个人信息的删除范围必须公开。

资料准备可以发生在接收后、执行前；UI 必须区分“已收到，准备资料中”和“Agent 已启动”。scope/selection/job 与 control
跨存储没有全局事务：先持久记录意图，用幂等的准备/claim/commit 阶段推进并在恢复时对账；中间失败不能调用 Pi。
一个提交里的多个选区必须全部有效才交付模型，禁止部分成功、其余静默丢失。

| 故障位置 | 恢复策略 |
|---|---|
| 未持久接收 | 客户端可以用相同幂等键重试，不先清掉草稿 |
| 已接收、未 dispatch | 可恢复准备队列，重新核验权限/版本/过期选区后再启动 |
| dispatch 后无确定接受/执行结果 | outcome-unknown；先看 Pi 文件、tool receipt、job 状态，禁止盲重跑 |
| domain 已提交但 tool result 未送达 | 通过同一幂等键返回已提交结果，不再创建 Note/Claim |
| native Bash/edit 已执行但完成事件丢失 | 不承诺 exactly-once；明确“结果待核验”，提供文件/结果检查和人类决定 |
| 文本生成完成、checkpoint 未完成 | 显示保存中/保存失败，不将流式结束当冷恢复成功 |

幂等键必须绑定 actor/workspace/conversation、payload hash、预期 branch/generation；同键不同内容冲突。
Pi 内部 retry/compaction 属于同一次运行推进，不重新消费选区；steer/follow-up 是独立 submission，在实际生效边界绑定 scope。
不能稳定映射的队列动作先明确拒绝/保留待发送，而不是假装支持或静默退化为普通 send。

首个 spike 比较实际 SDK 启动/首问/stream/cancel/settled 时序与磁盘状态；特别测试首 assistant 前进程退出、工具后退出、
fsync/写盘故障、分支替换失败。机器掉电保证只有对应故障验证通过后才声明。

## 8. 保留 Pi 能力，也保留真实权限边界

Pi 原生 read/bash/edit/write、可选 grep/find/ls、资源信任/Skills/extensions、模型/图像、retry/compaction、
steer/follow-up、session fork/branch/import/export 均在能力清单中；不是把 Pi 用成一个 prompt/abort 客户端。

### 首选安全方案（需 R1 spike）

完整 Pi worker 在受控 Linux mount/PID/network 边界运行，项目区 RW、已授权 source revision RO，产品 DB、宿主 home、
会话文件和凭据目录不挂载。Pi sessions 由受控通道持久到产品管理区，不能成为 agent 的可编辑项目文件。
模型 broker 在可信服务侧持有凭据；worker 经限定 provider/model、run 预算、取消信号的通道请求模型流。
Python sidecar 无凭据，文档解析也有独立资源/进程边界。

这里有两个必须证明的 seam：Pi 原生 SessionManager 文件持久化如何在 worker 中与 native tools 的文件访问隔离；
ModelRuntime 的公开 provider/stream 接口如何桥接而不损失 tool calling、image/reasoning、usage/retry/custom providers。
若整 worker 方案需要窄存储挂载（Pi 可写、native 工具不可达），必须由不同权限/执行域实现，不能指望同一 UID 的目录权限。
备选为可信 Pi runtime + 全 native I/O 的受限 operations backend；但必须覆盖全部工具、显式 executeBash、资源重载和扩展。
单一工具 wrapper 不能作为最终隔离方案，具体取舍在 R1-004a 冻结。

源码证据：低层工具 factories 暴露 Operations，但 `createAgentSession` 当前只接受工具名称/自定义 tools，
并不直接提供一套通用 operations 注入参数；显式 `executeBash` 另有 operations 参数。因此不能宣称“传个 cwd 或
spawnHook 就全部安全”。不得覆盖原生 read 为 DocAtlas read，也不得破坏原生 hook/图像规范化/文件 mutation queue。
公开 `AgentSessionConfig.baseToolsOverride` 是另一个候选 seam，`AgentSessionRuntime` 可注入 runtime factory；
它们允许在不复制 loop 的前提下组合原生 tools。不过 baseToolsOverride 会把 AgentTool 合成 minimal ToolDefinition，
必须检查 prompt metadata、全部可选工具、设置变更/reload、扩展 override 和显式 Bash 是否保留，不能只测一次 read 就定方案。

其他要求：

- 此环境能发现 bwrap/docker/unshare 可执行文件，不代表 namespace/cgroup/daemon/权限已经可用；启动时真实自检。
- 所选隔离机制不可用即停止该执行路径并说明原因，不自动退回 unrestricted host shell；本轮未安装/修改宿主设置。
- 默认文档/工具网络无任意外发；通用编码确需依赖下载或外部动作时，通过明确能力/审批打开，保留能力但不扩大隐式授权。
- worker 发来的 actor 只能是 agent/tool，不能声明自己是 user 来写 Policy、画像确认或 sign-off。
- 用户信任的扩展代码有较大能力；未知项目/上传内容不能自动成为 trusted extension、AGENTS 或工具配置。
- Web 无法直接渲染的任意 TUI widget 需声明 terminal-only；select/confirm/input/editor 等有 Web 映射、超时与取消。
- 停止覆盖 model、retry、compaction、显式 Bash、sidecar 和审批；必要时终止整个受管进程树，确认退出后才显示停止。

## 9. PDF 准备与真正的出处

### 原文先可看，解析随后推进

上传后的原始 bytes/hash/版本提交成功即可展示 PDF；text/blocks/FTS/tree/visual/OCR 能力分别报告。
问题需要的检索尚未就绪时进入准备状态；原文可看不等于全文能可靠总结。首次能力基线用现有 sidecar，
Flash 作为独立 generation/provider 对照演进，不把是否采用 Flash 变成 Reader 的前置条件。

### 引用链

```text
Read 的真实返回 → source/revision/representation/Locator + tool receipt
→ 当前授权运行的 locator catalog
→ 模型给 material span 关联 locator ID
→ Core 编译 AnswerManifest（检查来源、执行绑定、文本 hash）
→ Web 显示可点引用
→ 点击时重新授权/resolve → 原 PDF 页身份核验 → geometry 转换/高亮
```

引用 ID 不由模型发明；Search、tree 摘要、旧 Note、Pi 压缩摘要不能直接进入已支持证据集合。
用户选区由服务端验证后产生 selection evidence receipt；模型后续使用它时，显式计入本次已准入的原文读取，
不能为免一次 Read 就跳过证据门槛，也不能用客户端 quote 直接签发 Evidence。

默认用现有 PDF.js 交互承接；服务端返回原始 PDF bytes、校验身份与可验证 Locator，不让客户端提交可信坐标。
PDFium/sidecar geometry 到 PDF.js viewport 要测 physical page、CropBox、rotation、userUnit、缩放和多行区域。
没有 geometry 时，只允许对服务端已校验、绑定原件的 quote 做唯一原文字层匹配；不唯一或坐标不可信就 page-only/ambiguous，
不把跨栏整页大框当精准段落，不退回 MD。正式 renderer/几何字段仍在 R3-003 review 中，不据 Demo selector 宣称全格式支持。

流式文本是 provisional；未完成的 citation marker 不能成为可点链接。最终 manifest 绑定确切 message/answer hash 后启用。
编译失败保留答案并显示引用未核验；禁止从附近文字猜出出处。引用本身应区分“原文位置已核验”和“语义支持已审阅”，
后者需要 Claim/Review，不能用一个绿色勾把两种保证混在一起。

完整摘要也不能只读 locate 返回的一小撮段落：agent 根据 tree/coverage 规划，blocks/expand 看相关细节，
sequential 分窗补齐全文覆盖，visual 按需检查图表。回答明确已读范围/未覆盖内容和取数口径。

### 五种 Read 保持一个 tool

locate 候选定位；blocks 确定块；expand 上下文；sequential 连续窗口/覆盖；visual 原页/图像。
复用现有限额/cursor，首版保持默认 text budget 约 6,000 chars 的行为并实测；图片另算像素/字节预算。
更大的 UI 原文由 asset 接口按需取，不随 tool result 塞给模型或 SSE。现有 compiler 的 16-citation 实现上限与 schema
较大上限需要显式处理：标注未覆盖/分页产出或评审提升限制，不静默丢引用后称为完整。

## 10. 研究记忆与个性化的接入顺序

先做确定性、可纠正的能力，再做学习：

1. 真实 Note：显式保存原文摘录/评论、编辑、删除、跨会话返回原件；是研究对象，不是自动画像。
2. Research recall：带权限、版本、Evidence lineage 的旧工作 lead；用户纳入旧来源后重新读/核验，再用于本次回答。
3. Claim/Review/Publish：支持/反驳/限定、衍生计算、冲突、G0–G4 与人类签署；不由聊天“保存”顺带发布。
4. 显式个人偏好：语言、简洁/分点、解释深度等低风险轴，独立 profile 存储，why-used/编辑/暂停/忘记先可用。
5. 受控学习：observation → candidate → 确认/策略 → version → use/outcome；单变量 Probe 低频、可跳过、不从一次选择推全局偏好。

第 4 项的设置持久化可与 Note 分工开展；第 5 项依赖治理/纵向评测，不借本次后端接入直接默认开启。
“使用旧偏好/贡献未来偏好”与“引用旧研究/积累研究”四个开关分别处理，Temporary 的影响范围明确。
off/on 测试共用事实、Evidence、冲突与不确定性：可以改解释方式，不能改证据门槛、隐藏风险或换成 MD 落点。

2026-09-09有界接入：Note/Recall、显式偏好临时模型指导与人类Claim/Review均已有实际产品路径；第5项自动学习仍未开启。
[ADR-045](../adr/045-local-human-review-workbench.md)定义`product-review`六动作与原Evidence/历史快照/整commandHash，
host经原conversation与completed Answer publication授权后调用同一Core/M4。人类workbench的历史scope不是native source准入。
默认Brief/Matrix由固定ClaimVersion组织，G0–G4和签署分别保存，最新journal顺序批准才可本地发布；已提交发布可原key对账，
不会因后续拒绝重写历史。unknown Web请求不自动重放/换scope。derived gate验证输入状态，不执行算术证明；Continuity和完整恢复仍待。

## 11. 按可体验结果拆执行包

不创建与 R 计划竞争的 B/M 编号；下表的子包挂在原 R ID 下。

| 顺序与工作包 | 可交付结果 | 必须先通过的 gate |
|---|---|---|
| 1 · R1-001a / R1-004a | 运行合同候选、native/model/storage 隔离 spike、首问 crash 实验；选定公开 SDK 可实现方案 | 不造假持久化、无静默 unrestricted fallback、公开 exports 可用 |
| 2 · R1-001b | 产品 control contracts/fixtures、identity、提交/审批/观察状态机、幂等控制库 | duplicate/payload conflict/unknown version/恢复场景 |
| 3 · R1-002 / R1-003 / R1-004b / R1-005 | 有认证的最小真聊天接现有 Web，原生 read/edit/bash 可运行、流式/取消/恢复 | faux-provider 集成、同条件 native parity、IPC/模型/文件隔离 |
| 4 · R2-001 / R2-002 / R2-003 | Core 提取、原件上传/准备/Library、五种 Read、选区事务与 sidecar supervisor | 旧 DSH 等价、原件 hash/版本、全入口准入、crash/worker 限额 |
| 5 · R3-001…003 / R3-004 的 selection 部分 | 用户 PDF 真摘要/追问，引用只到原始 PDF，选区问答，刷新继续 | 模型读过原文、无错跳/假框、同名/新版本/权限/断线测试 |
| 6 · R3-004 Compare / R4-001…003 | 多文档比较、Note/旧研究、Claim/Review/Publish | 多来源不串、旧证据重验、no circular support、人类权限 |
| 7 · R4-004/005 | 真实个性化控制与受控 Probe | 同事实回归、why-used、遗忘/导出、纵向校准 |
| 8 · R5 / R6 / R7 | Flash 质量/资源优化、完整混合任务、升级恢复与正式发布 | 全 native parity、业务数据评测、安全/隐私/回滚 |

第 3 步不是最终产品，只是首个能运行的后端增量；第 5 步才是首个真实文档使用闭环；第 8 步才考虑切默认入口。
R5 的纯离线质量实验可在依赖满足时分工，不阻塞普通文档基线；“可分工”不等于自动授权多个 Agent。

### 第一个实际实现包

只先做 R1-001a/004a：

- 精确安装已审阅的公开 Pi release 到 runtime-pi，锁定实际依赖图并检查 exports/Node 兼容；不 import `.sources`。
- 用临时目录与 faux provider 运行首问/工具/取消/分支/崩溃实验，不调用 Azure、不碰既有数据。
- 验证 worker + 模型流 + Pi 存档/原生工具隔离的最小组合；检查 SDK 的可实现性，不先写完整业务 API。
- 将实测结果写回 ADR-023/R1，随后签合同 fixtures；如需 SDK 小补丁，列出具体 diff/兼容/维护成本后评审。
- 产物是可复现的试验与明确的工程选择；不展示伪 HTTP endpoint、伪数据库或“后端已部署”。

## 12. 验收矩阵与故障注入

| 类别 | 必测场景 |
|---|---|
| 运行 | 第一个 assistant 前 crash、重复发送、同键异文、compaction/retry 后才 settled、迟到旧 generation、two-tab writer |
| 取消 | 模型流/显式 Bash/并行 tools/Python 解析/审批等待，子进程真正退出，部分提交可查询 |
| 文档 | 中文/英文/多栏/长表格/扫描缺文字层/重复句/损坏加密 PDF、同名不同 bytes、旧 revision、全文覆盖 |
| 引用 | 错 source/hash/page/rotation、缺 bbox/歧义、缺 Read receipt、伪 marker、流式断片、计算不伪装原句 |
| Web | 真 server+Pi+sidecar（fake model 只替换供应端）、后续提问/@/选区全部准入、刷新/重连、窄屏/axe |
| 安全 | 未登录、CSRF、路径穿越/symlink/TOCTOU、跨 source/工作区、native 读取 DB/凭据、worker 冒充人类、恶意 PDF |
| 研究 | Note 编辑/删除、跨会话旧工作、撤销权限、revision impact、Review/Publish 与 branch 不互相回滚 |
| 个性化 | on/off 事实不变、文档不可写 active preference、scope/Probe 频率、forget/WAL/backup 的真实范围 |
| 维护 | frozen install、公开依赖一致、旧 DSH tests、升级/backup/restore、kill/重启/重绑定 |

真实模型测试在确定性回归后显式 opt-in，沿用已验证的 Azure Luna 配置与短期凭据规则；不能把旧 DSH smoke 当 Pi 成功。
速度报告先采集 ingest→readable/searchable、首次 token、citation resolve、CPU/RSS/峰值 tool chars，再给 p50/p95；
沿用主计划性能目标，不把样例速度或测试通过数当文档质量/SOTA 证明。

## 13. 维护和首次发布边界

- 每个提取包同时记录来源/目标、合同影响、旧/new tests、数据迁移与 rollback；code/data/product 三个 gate 分开。
- 新后端 launcher 与 Demo 预览并存；新模式绝不在服务不可达时回退脚本答案，Demo 明确标记且不混用存储。
- 初期只构建需要的 capability；未接通功能在 Web 显示不可用原因，不把空按钮做成已实现的服务。
- Pi 以公开 npm exact version + lock 接入，source pins 独立核对；上游升级先读 diff 再 parity，不追 main 自动更新。
- 暂不切换默认启动、不公开公网、不导入历史生产 DB、不宣布任意 TUI 扩展都能在 Web 工作。
- 产品仓库纳管方式仍需用户选择（外层目前未独立版本化）；不自动 git init、广域 add/commit 或重命名目录。

## 14. 本次设计依据与验证范围

- 再核对本地 Pi v0.85.1 SDK/session/session-manager/native tool factories、显式 Bash 与 resource services。
- npm 元数据只读查询确认 `@earendil-works/pi-coding-agent@0.85.1` 发布版本及 Node >=22.19.0 声明；未安装、未运行 SDK。
- 再核对 selection-service、answer-manifest、source-scope-store、tools、sidecar supervisor/spawn 与 Python resolve/geometry。
- 三个新发现落实为 gate：Selection stage 仍是内存态；原生工具 operations 不能直接经高层 SDK 一次注入；
  Answer compiler 的 DSH turn/call catalog 与引用上限需显式迁移。
- 底层公开 AgentSessionConfig.baseToolsOverride/runtime factory 是可验证备选；是否足够保持 native metadata/资源行为尚未执行证明。
- 本文没有冻结 JSON schema、数据库版本、安全实现或正式 renderer；它们有工作包和退出条件，不以设计文档代替运行验证。
