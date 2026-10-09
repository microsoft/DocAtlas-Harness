# Pi Answer 引用与真实本机入口

> 2026-09-09 · 实现记录；完整目标仍未完成

本批落实主计划 A 的关键路径，而不是继续增加非阻塞 Flash 选项。引用、浏览器、契约/测试并行后，继续接独立产品
launcher、真实 Azure ModelRuntime 与已确认的 chat-first 外观。原 DSH 和模拟原型仍保留。

## 可验证的变化

- Core Read 根据自己的 active submission/scope 记录宿主凭据；native toolCallId 随现有 document IPC 传递，不用 RPC ID 冒充。
- 新 AnswerReceipts 私有库保存 exact ReadResult 与完成后的 publication link；canonical AnswerManifest 仍由 SourceScopeStore 拥有。
- Pi projector 读取同一个 verified checkpoint prefix，配对真实 call/result 与独立宿主记录；Search/locate/旧轮次/模型自报 details 不能创建证据。
- 正常 Pi metadata 不影响归属；compaction/steer/custom message 尚不能证明归属时保留 gap，不捏造引用。
- product-answer wire 支持 readonly manifest 与 citation focus，actor/path/geometry 不来自浏览器。点引用重验权限和同版原件，独立 cache-only resolver 等真实 join。
- Web 校验 native raw hash 与 visible answer hash，只让 read-verified 提供按钮；unknown/locator-only 留待核验。PDF.js 同页唯一 quote 才高亮，歧义不猜框。
- 独立 launcher 装配真实服务，默认 loopback:4177、一次性配对、独立状态、正常关闭/原生恢复。历史按需打开，空会话沿用已确认的居中聊天设计。
- Azure provider 保留 gpt-5.6-luna，用 Pi 公开 Responses API。官方文档影响了 reasoning 映射、store:false 和 capabilities；不是改用另一个模型/聊天 loop。

## 定位并修复的集成问题

1. Node22 SQLite TEXT 含 NUL 的复合键在读取时截断；改 JSON tuple key，保留 native call 的原始身份。
2. ReadResult 必须保留 JSON 字段顺序以匹配 native 首 text；manifest/checkpoint 的独立 seal 使用 canonical hash，不把不同序列化误判为不同事实。
3. 引用 prompt 提取后 runtime worker 真正依赖 Core；补只读 Core 代码挂载，不添加产品数据挂载或放开原生权限。
4. locator-only 不应出现有效引用按钮；已改成非交互定位线索。
5. Pi auth 的 AbortSignal race 可能在 az 子进程退出前返回；host 请求终结门控等待实际 helper close，且不同请求取消互不影响。
6. 上游 SSE partial 可共享后续错误对象；Azure adapter 复制 partial 并移除错误诊断，禁止原 provider 错误正文进入 worker/native 记录。
7. 真实探针首次误用Library摘要字段（应为currentRevisionId），在提交前失败，已修。后续真实工具调用又发现Responses自动strict规范化
   迫使Read填满不适用的可选参数；按官方说明显式strict:false（Pi compat capability）修复。保留Core严格mode union和原生工具，没有增加重试预算掩盖失败。

## 验证范围

最终`bash scripts/check.sh`通过：118个JS文件、998个可执行测试、423 Python passed，既有opt-in skip保留。
JS摘要输出被截断后另用当前`vitest list --json`核对文件/测试数，不采用包含旧测试条目的cache。完整命令/限制见任务板。
浏览器最终live 11/11、原型14/14、legacy Reader 6/6，共31项通过。其中合成 PDF→Pi sources/read→动态 locator→保存→
原 PDF page2 高亮→刷新同引用的模型是faux，但PDF/HTTP/Pi/sidecar/原件字节和定位均真实。
独立产品组合的4项测试验证实际认证/隔离Pi/同原JSONL重开而不重跑模型。
Azure官方真实transport smoke已返回 PI_AZURE_LUNA_OK；这不等于真实PDF语料质量验收。
修复strict语义并核对探针Q4问题后，真实Azure端到端smoke也返回PI_AZURE_LUNA_PDF_CITATION_OK：3次model calls，
真实Pi checkpoint、host Read-backed citation及原件page2/exact quote核验通过。此前探针把Q4值误当全年值的断言也已纠正，未改变模型答案来凑成功。

实际CLI在4177启动后首页200、未认证bootstrap为401，随后正常关闭；未保留常驻服务。实际应用的桌面/手机截图没有横向溢出，
但图像工具无法显示，因此不声称已人工目检。浏览器SSE诊断确认初始resync后持续OPEN，没有重连或模型调用；
初始同步与重连共用的状态文案只保留“正在重新同步”，避免在没有断线时误报。

相关边界和来源见[ADR-039](../docs/adr/039-checkpoint-backed-answer-citations.md)、[ADR-040](../docs/adr/040-local-product-launcher.md)、
[使用说明](../docs/product/local-web-beta.md)。Flash上游vendor未改，上一批显式增强仍保留。后续继续多文档/Compare、研究积累、
受控个性化、全格式几何/长文/OCR质量、原生全能力界面、异常恢复与正式发布，不把本机beta当完整计划完成。
