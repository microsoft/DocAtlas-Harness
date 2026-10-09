# Flash 增强、主 Agent 导航与并行收尾

> 2026-09-09 · 内部实现记录，不是正式部署或真实模型质量验收

## 已实现

- 原 raw/merge generation 不改；summary / expand / full 以显式、独立预算作业生成 `navigationOnly` overlay。
- Core 实现 bottom-up 摘要、短叶子 source-excerpt、仅原文出现的 Unicode 标题展开，以及严格下降的 routing/worst-scan cost。
- 模型使用 Pi ModelRuntime 单次无 tools 转换；不新建 Agent Loop，不把凭据交给 Python。作业有 source/input/result seals、provider/usage。
- 私有 SQLite 保存 queued/preparing/generating/terminal，接受与执行分开，同键 completed 重读不调用模型。取消等待 provider 与实际文档进程结束；不按 PID/TTL 猜测接管未知作业。
- Library 的 Flash drawer 提供节点/模式、预算、显式启动/取消、刷新后核对同一作业。
- `docatlas_enrichment` 主 Pi 工具列出已完成 overlay 或分页读取完整节点；整份返回受字符限制，不偷偷截断摘要。重验 active invocation、原件/表征 hash，不能自动运行作业，也不能替代 Read 成为事实依据。
- Core 提取 host-neutral Answer compiler；旧 DSH 只保留标准事件 adapter，ID/hash/引用上限与明确 gap 行为不改。Pi checkpoint→Answer→Reader 尚未接通，此项只是减少下一步重复实现。

## 实际定位的问题

浏览器首次失败不是服务没有响应，而是合成 PDF 没有 Flash 可识别目录，后端合法返回 empty-tree，前端仍提示选节点。
测试 PDF 增加真实嵌入书签后验证完整模型摘要路径；另保留无书签版本，验证空树提示与零模型调用。
“没有检测到目录”不表示没有可读正文；FTS/Read 独立可用。

全套 live 回归又遇到 Chromium `Network.getResponseBody` 缓存不可用，而页面已显示六个真实目录节点。
测试改用 `route.fetch()` 获取同一次真实响应并原样转发，继续校验 hybrid/nodeCount 与 UI/模型调用/持久化，不制造响应或删断言。

共享反例又发现 Python `jsonschema.FormatChecker` 缺少可选日期校验器，会接受非法 `date-time`。
显式固定 `rfc3339-validator==0.1.4`，同步两份 Python manifest/lock，不删除日期反例。

## 验证分层

- enrichment 六种 wire union：27 个 valid、71 个 invalid-shape、46 个 invalid-semantic fixture。Node/Python shape 与 browser/consumer semantics 分层说明，不把 Python shape 检查冒充跨字段语义验证。
- Core 算法/导航/存储：预算、原树不可变、造假标题/JSON、持久 claim、跨 owner、active frame、旧表征/原件、分页整节点。
- Pi 模型适配：单调用/no tools、取消后 provider join、流式及最终 Unicode 预算、迟到权限撤销、无效 stop/toolCall。
- 浏览器：真实 PDF parser/目录/HTTP/Pi 模型适配/持久结果/刷新；模型是明确 faux provider，不能代表摘要、分节或问答质量。
- 最终整套回归结果见 [执行任务板](../docs/execution-tracker.md)，不以先前批次通过数代替本批。

## 仍待完成

真实 Azure/provider 与长文/中文/OCR/复杂布局的质量及速度对照；legacy/full/默认选型；失败/取消作业的完整用量 ledger；
unclean claim 人工核验与恢复/retention 管理。当前独立配方不声称逐字节等同上游完整优化器。

下一关键交付是正式内部启动入口与最终回答引用跳转原始 PDF：必须绑定真实 checkpoint、成功 Read 与同一来源，
不能从临时流式文本/模型自报 Locator/浏览器输入直接获得证据权威。再继续多文档、研究/个性化和完整发布验收。
