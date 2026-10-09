# DSH 架构、插件边界与 DocAtlas 接入方案

> 研究日期：2026-08-29  
> DSH 固定版本：[`cd5ef814`](https://github.com/deepseek-ai/deepseek-harness/tree/cd5ef8148158c3a752a658978873241fdf8e2bbc)，发布版 `0.1.2-alpha.1`  
> 二次开发参考：[`dsh-worktable@de4c5e2`](https://github.com/Aisland-SJL/dsh-worktable/tree/de4c5e2bf8404ae06dd1d1a97313bf832f0489b3)

## 结论先行

DocAtlas 不应迁移 TUI，也不应实现第二套 Agent Loop。推荐形态是一组静态 DSH
Host/Client 插件：DSH 继续拥有模型、会话、权限、队列、压缩与 Agent Loop；DocAtlas
只提供文档服务、命名空间化工具、可回放的文档状态投影、个性化记忆和一个新的
`conversation.view`。

第一版可以做到 **零 DSH 源码补丁**：

- `conversation.view` 新增 `DocAtlas` 会话页；DSH 自己的 header、tab、composer 与会话切换继续常驻。
- `conversation.session.header.actions` 放打开文档页、跟随 Agent 等轻量动作。
- `tool.call.toolview` 为 `docatlas_*` 工具显示页码、证据和进度，不接管通用工具卡。
- `conversation.input.dock` 显示用户选中的页、文本或区域，即将随下一条问题发送的上下文。
- `shell.overlay` 只放快速打开、选择浮层和全局 toast，不把主阅读器长期悬浮在这里。

当前公开 slot 没有“在聊天旁边追加一个会自动参与宿主布局让步的文档 sidecar”。如果产品验证出
聊天与原文永久并排是核心路径，再向上游提一个很小的 additive workspace/sidecar slot；不要复制
或替换 `AppFrame`。

这与[官方 Developer Preview](https://www.deepseek.com/harness/en/) 的定位一致：能力通过插件组合，
运行记录进入 append-only session log，同时官方也明确说明 core plugins/API 仍会继续演进。因而
“零源码补丁”和“固定已审查 commit”不是保守姿态，而是当前生态下最可维护的产品策略。

## 1. 观察到的 DSH 责任边界

以下是固定版本源码能证明的事实，不是 DocAtlas 提案。

| 能力 | DSH 所有者 | 对 DocAtlas 的含义 |
|---|---|---|
| Agent Loop | `@deepseek-ai/dsh-agent-loop` | 不再运行 `docatlas/agent/loop.py`；工具结果回到 DSH 的下一 step。 |
| 会话真相 | append-only Session Event log | DocAtlas 的模型可见动作应落进已有 `tool/call`、`tool/result`，从而可恢复、fork 和 replay。 |
| 工具执行 | `ctx.tools` 与 pre/execute/post/result waterfalls | DocAtlas 注册工具，继承 DSH 取消、并发、审批和错误语义。 |
| Web Host 通信 | `ctx.connection` + API Gateway | 自有 RPC channel 和 `/api` exact Fetch route 可以复用浏览器认证与 Host/Origin 防线。 |
| 跨会话 KV | `ctx.storageDomain` | 适合小而有界的画像/偏好 sidecar；不属于 Session log。 |
| 会话派生状态 | `ctx.sessionProjections` | 可纯 fold 现有事件，为 Client 提供可重建的 DocAtlas 会话快照。 |
| Web 组合 | typed React Slots | 插件通过 additive slot 入驻，不导入其他 feature 的运行时组件。 |

DSH 的一轮次序是：claim 输入 → `agent/pre-step` → 写 `user/message` → 组 prompt → 调模型 →
写 `assistant/message` → 执行工具 → 写 `tool/result` → 下一 step 或 `turn/end`。因此文档工具不是
Loop 外围的聊天服务，而是 DSH Loop 里的普通工具。

参考：

- [Agent lifecycle](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/agent-lifecycle.md)
- [Web Client architecture](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/web-client.md)
- [Tools subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/tools.md)

## 2. Web slot 选择

固定版本的完整层级见 DSH 的
[`slots.md`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/slots.md)。

| Slot | 基数 / scope | 是否推荐 | 用途与风险 |
|---|---|---:|---|
| `conversation.view` | list / session | 是，主入口 | 新 id 是纯增量；一次只显示一个 View。DocAtlas 可以拥有内部滚动区，DSH composer 仍常驻。 |
| `conversation.session.header.actions` | list / session | 是 | 打开阅读页、回到当前证据、Agent follow 开关。 |
| `conversation.session.header.utilities` | list / session | 可选 | 很轻的文档状态或同步状态，不能塞完整工具栏。 |
| `tool.call.toolview` | keyed / session | 是 | key 使用 `docatlas_search` 等自有工具名；回放时只依赖冻结的 call/result。 |
| `conversation.input.dock` | list / session | 是 | 显示下一次提问绑定的选区和文档 locator。 |
| `shell.overlay` | list / root | 仅浮层 | 适合 modal、palette、toast；作为长期工作区会绕开宿主布局、焦点和响应式让步。 |
| `details` | single / session | 否 | 已由 DSH 的 tool details 占用；注册会整体替换而非追加。 |
| `conversation` | single / session-maybe | 否 | 会替换整个会话壳，并带走内部 header、composer 和 slots。维护成本最高。 |

`conversation.view` 还有两个对 DocAtlas 很有用的现成约定：

1. View 选择按 session 保存，重新打开会话可回到阅读页。
2. `openView(view, focus)` 可携带一次性的 opaque focus id。证据卡、工具卡可以请求
   `openView("docatlas", locatorId)`，阅读页消费后调用 `completeViewRequest()`。

如果 View 根节点声明 `data-conversation-composer-overlay`，宿主会让 View 自己管理内部 scroller，
并把 composer 保持在底部 overlay seat；Trajectory View 已经走这条路径。这比复制 composer
安全得多。

## 3. 推荐插件形态

### 3.1 静态包，不用动态 Cordis 包承载产品

动态 Cordis package 很适合模型临时定义工具和小 UI，但当前浏览器 half：

- 不能 import 模块或 JSX，只能用固定的 `React.createElement`/CSS surface；
- 刷新后不会自动恢复，必须重新 run；
- 有页面时才可批准 browser half，headless 会挂起；
- UI 完成加载不等于 React 已成功渲染。

DocAtlas 是长期安装、需要稳定数据协议和复杂阅读器的产品，应发布普通 DSH npm/link 插件，拥有
Host 与 Client 两个构建产物。动态 Cordis 只保留为开发期原型工具。

### 3.2 逻辑模块

```text
DSH Host
├─ DocAtlasService
│  ├─ DocumentCatalog        内容哈希、文档身份、状态
│  ├─ DocumentProvider      local DocAtlas / PageIndex cloud / future providers
│  ├─ EvidenceService       locator、EvidenceAtom、引用校验
│  ├─ ClaimService          claim/version/relation/verification/artifact manifest
│  ├─ Personalization       profile、candidate、recall、usage audit
│  └─ SidecarSupervisor     只管理文档 Python 服务，不管理 Agent Loop
├─ docatlas_* tools          DSH 模型工具
├─ DocAtlas Projection       join DSH tool events + Investigation Journal
└─ authenticated transport   ctx.connection RPC / Fetch

DSH Web Client
├─ DocAtlas client model     baseline + commands + cancellation
├─ conversation.view         文档理解页面
├─ tool.call.toolview        文档工具卡
├─ header/input slots        打开、定位、选区上下文
└─ memory controls           why-used / edit / forget / scope
```

环境骨架已创建以下 Host/Client package；contracts 审批后再增加业务模块：

```text
plugins/docatlas-dsh/
├─ package.json
├─ cordis.patch.yml
├─ src/
│  ├─ contracts/             纯 JSON/TypeScript wire types
│  ├─ host/
│  │  ├─ providers/
│  │  ├─ tools/
│  │  ├─ projection/
│  │  ├─ memory/
│  │  ├─ transport/
│  │  └─ sidecar/
│  └─ client/
│     ├─ model/
│     ├─ views/
│     ├─ toolviews/
│     └─ styles/
└─ tests/
   ├─ contract/
   ├─ host/
   ├─ client/
   └─ e2e/
```

固定 DSH 源码实际消费的是 `package.json#dsh` 与 `cordis.patch.yml`；社区项目中的 `dsh.plugin.json` 不在该
运行时加载路径中，因此骨架不创建第二份 manifest。

## 4. Python 核心如何变成插件能力

现有 DocAtlas Skills 已经是 JSON-over-stdio，这给迁移期提供了很好的窄腰协议。分两步：

1. **Vertical slice**：Host tool 通过受控子进程调用既有 `search/read/note/review` CLI。启动命令、
   环境和取消都由 SidecarSupervisor 统一管理，Python 只返回文档结果，不请求模型、不循环。
2. **稳定期**：换成长驻 JSON-RPC stdio sidecar，复用加载后的 PDF/tree/Markdown 缓存，避免每次
   Python 冷启动。每个请求必须带 `requestId`、`sessionId`、`documentSetId` 和取消信号映射。

无论哪一步，都保持：

- DSH 工具 schema 是唯一模型可见 schema；
- Python 不保存 DSH 对话历史，不持有模型 key；
- DocAtlas 的辅助 tree search 若仍需要模型，先通过 Host 的 DSH LLM capability 调用，或者明确
  作为 provider 内部辅助请求记录成本；不能偷偷恢复原 Agent Loop；
- 所有 Python 启动和依赖管理都在本项目通过 `uv` 完成。

## 5. 工具和事件设计

### 5.1 工具必须命名空间化

DSH 已有 `read` 等通用工具。推荐首版工具：

```text
docatlas_search
docatlas_read
docatlas_record
docatlas_review
docatlas_publish_brief
```

`docatlas_record` 把 observation 拆成 claims 并绑定 evidence；`docatlas_publish_brief` 是 Verify/Publish
模式的结构化交付门。后续再根据真实轨迹决定是否增加 `docatlas_compare`、`docatlas_memory_recall` 和
`docatlas_memory_propose`。不要一开始把 PageIndex 的管理工具和 DocAtlas 内部操作全部暴露给模型。

### 5.2 使用已有 `tool/result.meta`

DSH 的 `ToolResult.meta` 是 tool-owned、JSON-safe、与结果一起持久化并在 replay 时重现的 presentation
payload。DocAtlas 可以在其中放一个有版本的、受限大小的 state patch：

```ts
interface DocAtlasToolMetaV1 {
  schema: 'docatlas.tool-meta.v1'
  operation: 'search' | 'read' | 'record' | 'review' | 'publish'
  documentSetId: string
  locators?: DocumentLocator[]
  evidenceIds?: string[]
  claimVersionIds?: string[]
  artifactId?: string
  uiSummary: string
  truncated?: true
}
```

模型需要的文本仍在 `content`；UI 定位数据放 `meta`。不要把整页 Markdown、图片 base64 或整棵树塞进
Session log，Client 应按 locator 从 Host 取原文。

### 5.3 先不添加自定义 Session Event

`SessionEventMap` 在源码层可以 declaration merge，但持久化加载器会用当前 build 的
`KNOWN_SESSION_EVENT_TYPES` 拒绝未知事件。外置插件如果写入 DSH build 不认识的新 type，卸载插件、
换版本或在另一套 build 打开日志时会失败。

因此首版 Session Projection 只 fold：

- `tool/call`：识别 `docatlas_*` 名称与参数；
- `tool/result`：读取相同 call 的结果与 `meta`；
- `turn/end`：关闭 pending 状态；
- 标准消息：派生当前问题和回答关系。

这已经能重建 active document、最近 reads、claim summaries、citation focus 和运行状态。完整的人类
claim edit/review 存在 plugin-owned Investigation Journal；Session Projection 合并两者的 read model。只有当 DSH 提供
外部插件 event-vocabulary 注册/迁移契约后，才重新评估自定义事件。

### 5.4 交互使用 DSH 已有 loop seam

DocAtlas 不另造“Agent 运行中控制协议”：

- `agent.steer()`：用户在 Evidence Desk 改 source scope、要求找反例、拆 claim 或调整计划；在下一 step boundary 生效；
- `agent.followup()`：提交一个新的后续问题；
- `agent.inject()`：把用户选区或 review decision 作为下一 step 的一次性结构化 context；
- `ask_user_question` / pending interaction：高成本 plan、source boundary、claim conflict、publication review；
- DSH approval：联网导入、写长期 memory、外部导出等副作用；
- `agent/turn-stopping`：只做有界 deterministic completion gate，缺口用 steering 追加至多有限步骤；
- cancel/resume：read/search 可幂等重试，publish/export 必须先验证 domain/external state。

DSH 规定 runtime-owned child Agent 不能直接询问用户。并行文档 subagents 只返回 EvidenceRefs、ClaimPatch
和 OpenQuestions，root orchestrator 汇总后向用户提问并拥有最终 publish。

## 6. Host ↔ Client 通信

不要照搬旧插件直接把私有数据 route 注册到裸 `ctx.webServer`。当前 DSH 的统一浏览器信任边界在
`ctx.connection`：它校验 Host/Origin，并要求启动 token 换得的 HttpOnly cookie。

推荐：

- JSON 命令：`ctx.connection.rpc.handle('/docatlas', handler)`；Client 调
  `ctx.connection.rpc.call('/docatlas', endpoint, payload, signal)`。
- PDF、页面图、figure、导出文件：`ctx.connection.fetch.register()`，路径必须是 `/api/...` 的
  exact `GET`/`HEAD` route，因此自动位于相同认证边界内。
- 所有读取再做 session/document 授权，浏览器 cookie 只证明是这个 DSH 页面，不等于有权访问任意路径。
- 路径不直接由 Client 提交；Client 发送 opaque `documentId`/`assetId`，Host 从 catalog 解析并做
  content-root containment。

Typert Remote 是 DSH 内部最强类型路径，但应用的 `api-remotes` 在 build time 明确挑选贡献；外部插件
不能假设宿主已经把自己的 Remote contribution 加进 BFF。自有 authenticated RPC channel 是更现实的
独立插件边界。

## 7. 五类运行状态与真相来源

| 状态 | 权威来源 | 例子 |
|---|---|---|
| 会话事实 | DSH Session log | 问题、回答、steering、tool call/result、approval/cancel。 |
| DocAtlas 领域事实/Research Memory | append-only Investigation Journal | EvidenceAtom、ClaimVersion、ResearchNote、OpenQuestion、Decision、Review、ArtifactManifest。 |
| 会话派生状态 | Session/DocAtlas Projection，可重建 cache | active docs、已读页、claim coverage、Agent 当前定位。 |
| 跨会话个性化 | Host durable store | 用户偏好、候选记忆、版本链、使用审计。 |
| 大型文档产物 | content-addressed artifact store | PDF、Markdown、tree、page image、figure。 |

两个 journal 通过 session/turn/step/callId 与 ids/hashes 交叉引用，但不互相复制成第二份真相。Projection
只是 fold shortcut。文档产物也不能以原始路径作为身份，应至少使用
`sha256 + byteLength`，并把显示名、路径和 provider id 当作可变 metadata。

## 8. 从 dsh-worktable 学到什么

`dsh-worktable` 证明了以下路线可行：

- 一个安装包同时发布 Host Cordis 插件和 Web Client bundle；
- React 与 `@deepseek-ai/*` 作为 Host externals；
- `shell.overlay` 可以承载复杂工作台；
- Client 可订阅 Session snapshot 做零模型调用的状态镜像；
- 发布包、link 安装和 DSH 升级必须做真实 mount 验收。

但 DocAtlas 不应复制它的三项实现选择：

1. 工作台通过查找 DOM、假定 child 顺序并改写 `viewArea.style.margin*` 留出聊天列。这是有效原型，
   不是公开布局 API。
2. 视图、绑定和布局主要存在 `localStorage`，不适合作为跨设备或可审计的证据/记忆真相。
3. 冷会话预览调用了明确标注为非公开的 `face.history()`。

DocAtlas 主页面应占用公开的 `conversation.view`；临时选区/对话框才用 overlay。

## 9. 个性化进入 DSH 的位置

个性化不应改写文档事实。三个注入点按稳定性分开：

1. **稳定小画像**：有严格 token 上限，进入 system prompt 的独立 section，session 开始时冻结或按
   明确版本更新，利于 KV cache。
2. **本题相关记忆**：在 `agent/pre-step` 依据刚 claim 的用户消息做有界 recall，作为标注为
   untrusted background 的附加 context；或者由模型显式调用 `docatlas_memory_recall`。
3. **候选生成**：在 `turn/end` 后异步提取，只写 candidate，不自动成为 active memory。

工具结果、当前问题与引用都属于当前 session，不应先绕进长期记忆再返回本轮。

## 10. 维护与兼容策略

DSH 仍是 alpha，不能只写一个宽泛 peer range 后宣称兼容。每次升级执行：

1. `bash scripts/check_source_updates.sh` 只发现 drift。
2. 对候选 commit 审查以下路径 diff：slots、tools、session、projection、storage、connection、plugin loader。
3. 修改 `sources.lock.json` 后 `bash scripts/sync_sources.sh`。
4. 运行 contract probes：
   - 所需 slot 存在且 cardinality/scope 未变；
   - `tool/result.meta` 可持久化、冷恢复、fork、Client replay；
   - projection baseline/reconnect 正确；
   - storage schema mismatch fail-closed；
   - 自有 RPC/Fetch route 仍经过 Connection 认证；
   - 安装产物在干净 DSH profile 中可 `--dump-config`、启动、打开、卸载、回滚。
5. 浏览器 E2E 走真实用户路径，不以“bundle 编译成功”替代验收。

建议维护一张 `compat/dsh-matrix.json`，每一行只记录实际测过的 DSH tag、commit、Node、OS、插件版本、
通过的 contract/e2e id。发布默认 pin 精确插件版本，升级数据前先导出和备份。

## 11. 需要上游补充的最小能力

首版不依赖这些能力；产品验证后再提：

- additive、reflow-aware 的 `conversation.workspace.sidecar`，由 `AppFrame` 做宽度让步和响应式收起；
- 外部插件可登记持久 Session Event vocabulary 与迁移/缺席策略；
- application BFF 对外部 Remote contribution 的安全选择机制；
- storage-domain 的 schema migration hook 与跨进程 revision/notification。

这些是小而通用的宿主 seam，不应以“把 DocAtlas 合进 DSH 源码”解决。

## 12. 当前决策记录

| 决策 | 选择 | 理由 |
|---|---|---|
| Agent Loop | DSH | 避免双会话、双权限与双取消语义。 |
| 主 UI | additive `conversation.view` | 保留 DSH header/composer，零 DOM patch。 |
| 工具 | `docatlas_*` | 避免与 DSH `read` 等重名。 |
| 回放状态 | standard tool events + Investigation Journal + projection | 当前外部 custom Session Event 缺少可靠恢复契约。 |
| 浏览器传输 | authenticated Connection channel | 裸 webServer route 不在统一 cookie 防线内。 |
| Python | 文档 sidecar only | 复用 DocAtlas 能力，但不复活自己的 Loop。 |
| DSH 源码 | pin + read-only checkout | 上游更新可审查、可复现、可回滚。 |
