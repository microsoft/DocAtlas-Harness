# ADR-043 · 请求级偏好指导与真实生成使用记录

> 2026-09-09 · Accepted for the bounded local Pi beta application
> 扩展 ADR-042 的控制面；不改 v1 wire 的 `not-connected` 含义，不代表自动学习/Probe/全质量验收。

## 决定与用户行为

用户显式保存的六个低风险枚举轴，经同一 actor/workspace profile 的 `useExisting` 许可，可作用于下一次
实际消费的问题。DocAtlas Core 负责筛选/Decision/MemoryUse，产品宿主负责绑定实际运行请求和观察生成；
Pi 保留原来的 Agent Loop、工具、消息、模型路由、Session、extension hooks 和凭据代理。

这一步的价值是可控的表达适配：更合适的解释顺序/深度/术语/答复组织方式。不是熟悉度推断或自动积累习惯，
也不自动改变 Reader 排版。原文、检索排序、事实支持、反证披露、Review/Publish 门槛不接受偏好写入。
模型可能不遵从表达指导；程序不修改 Evidence 并不等于真实模型回答已通过事实非退化评测。

## 请求与存储边界

1. 只有精确 native consumption 已安装、仍在执行的 ProductResearch frame，以及真实主回答用途的模型请求可生成偏好计划。
   固定 SDK 的 `session.isCompacting` 覆盖自动/手动/分支摘要；worker 在原 `agent.streamFunction` 外保持原样调用，
   用一次性调用局部 token 精确绑定原 context 对象和当前 `agent.signal`，在 provider 边界消费。
   内部非持久 `model.stream` 新增有限用途 `agent-answer | auxiliary`，缺省 auxiliary；用途不是身份/文档授权，
   host 仍独立复查 binding/frame。直接/嵌套/失效或不匹配的辅助调用、压缩/分支摘要不应用也不记使用。
   不按提示词字符串、缓存 sessionId 或浏览器当前 PDF 猜测用途；不改 Pi patch 或禁用原生自动压缩。
2. 只用 ordinary/disclose、已由当前用户显式设置/确认、有效期内、允许六轴和当前工作区范围的 active memories。
   空/禁用/不适用偏好不创建 Decision，也不让无关研究存储配额阻塞普通 Pi 任务。
3. Core 确认 eligibility 后，由宿主惰性封存精确 fact-trace scope，再复查身份和 eligibility，编译至多六项 Decision。
   无文档的问题允许空 capture，但 capture 不准入文档，也不是研究 Note/事实证据。
4. 固定模板只包含枚举对应的表达指导，不含用户自由文本摘要、画像/记忆 IDs、原文或私人属性。计划对象是
   Core 实例发出的冻结能力，不能由模型/浏览器复制 JSON 后冒用。
5. 宿主在每次 provider request 的原 `systemPrompt` 末尾临时追加，broker 强制 UTF-8 追加上限 8192 bytes，
   校验 messages/tools 及其存在性完全不变。不修改提交 `modelText`，不把指导作为新消息写入 native JSONL，
   也不建立另一套聊天或模型循环。关闭/重启后重新按当前许可计算，不从旧 Decision 重放指导。
6. 原生批准 extension 的 `onPayload` 能看到并可能修改实际 provider payload，包括这段普通表达指导；这是保留 native
   hooks 的结果，不等于它能读取 profile 文件。MemoryUse证明host请求加入指导且观察到正文，不证明extension保留了所有指令。
   提供方/扩展/导出/模型输出中已产生的副本不承诺可由 forget 擦除。

## 使用记录的证据标准

保存设置、编译 Decision、调用模型都不足以创建 MemoryUse。必须由宿主观察到该已授权请求的第一个非空
`text_delta`，或成功完成后的非空 final text fallback；只有工具调用、空结果、未观察到正文的 error/aborted 不计。
同一实际 provider call 中每个入选 MemoryVersion 只写一次；后续工具轮次是独立实际调用，不伪装成一次最终页面展示。

复用领域 `affectedActions: ['answer-render']`，但新产品明确其有限含义为 `observed-answer-generation`：
**表达指导进入了一个确实产生正文的生成过程**，不是 DOM 展示、模型遵从、事实正确、完成 checkpoint 或最终发布。
`outcome.status` 保持 `unknown`。正文已生成后再取消，先前真实使用可能保留；整体 privacy erasure 按既有规则擦除自有记录，
迟到回调不能把已删除使用记录重新写回或从内存 receipt 返回。

## 撤销与生命周期

修改/暂停/忘记相关 profile 或关闭当前会话 `useExisting`，同步中止受影响的在途 provider 请求。
每个生成事件及最终结果都重新检查 profile、source、binding、frame 和有效期；发现失效后该 submission 持续失效，
不能通过 native 自动重试悄悄重新请求一个无偏好替代答案。用户可以明确发送新问题，按新设置执行。
该标记跨 provider 已关闭、native工具仍执行的间隙保留；已发生的工具副作用不被隐式回滚。
不同已消费提交的撤销分别保留，旧frame迟到回调不能覆盖新提交的标记；只保留当前/实际在途身份，正常切换后清理。

`contributeToFuture`、导出、幂等命令的 receipt 重放不撤销正在合法使用的偏好；其他会话的使用开关不影响本会话。
Profile 的新显式版本会影响正在使用该 profile 的请求。关闭后再开启也不复活已失效的那次提交。

Broker 必须等实际 provider result join 和 `onResult` 检查完成后，才向 Pi 发送 terminal progress；
4 并发槽位一直保留到 join/close。`close` 只释放资源，关键授权/写入在 awaited observation 中完成。
应用整体 shutdown 先等待 manager/worker 实际停止，再关闭偏好应用和 profile store。

## 版本与兼容

新增 `product-personalization-v2`，`schemaVersion: 2`，GET `/preferences/state` 提供真实
`modelApplication: host-ephemeral | not-connected`、`useSemantics: observed-answer-generation` 和 `profileEpoch`。
旧 v1 合同保持不变；接通模型应用的宿主对旧 GET `/preferences` 返回 conflict，要求客户端升级，而非谎报未连接。

POST `/preferences` 同时接 v1/v2 命令，按请求版本返回 receipt；新 Web 写 v2，原标签页尚未确认的 v1 命令
保留原 body/key/version 重试，不能静默升级幂等输入。只有同版本/同绑定/同命令结果才清除 outbox。
浏览器展示真实生成使用和未知效果，也明确设置变更可能停止当前回答，不自动代用户重问。

v2命令还必须携带读取时的 `expectedProfileEpoch`。这是为擦除后旧标签页的旧设置/旧许可不能复活而加入的非内容代际，
不是全profile revision CAS：普通设置/使用记录不改变epoch，完整privacy erasure才原子递增，不能随ledger归零。
Core profile元数据有限迁移到存储v2，保留既有内容/版本并生成受管迁移备份；已存在privacy-erasure receipt的v1库从非零epoch迁移。
产品宿主在命令事务内强制检查；旧v1命令只能属于epoch0，擦除后必须重新读取并显式创建v2请求，不能修改旧outbox的epoch后重试。
唯一例外是最新那次擦除的精确旧receipt对账，不得重做擦除或恢复任何记忆/许可。新epoch的明确设置仍可用。
epoch只保留整数，不保留已清除的traits/旧请求正文；原有WAL/受管备份/导出擦除保证继续。Legacy DSH未更改wire，
其直连领域调用默认兼容，不意味着旧适配器或跨宿主数据迁移已完成此产品epoch门禁。

## 验收与剩余项

需要 Core/host/broker 生命周期测试、真实隔离 Pi + faux provider 的上下文/原生文件/恢复检查、双版本 fixtures、
浏览器 outbox/设置/使用记录回归和旧 DSH/原型回归。具体运行结果记录在[任务板](../execution-tracker.md)，
不把 faux 的固定回答当付费模型/真实业务文档个性化效果证明。

尚未开放：自动观察/候选学习、单变量 Probe、任务模式自动适配、Reader 自动重排、高影响检索/反证策略、
长期质量校准及完整恢复/生产部署。R4-004/005 与完整计划仍按各自 gate 推进。
