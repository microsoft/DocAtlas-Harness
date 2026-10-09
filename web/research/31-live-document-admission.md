# 真实上传到 Pi/Flash/Read 与同版原文

> 2026-09-09 · 第十三批 · [ADR-036](../docs/adr/036-live-document-admission.md)。完整目标与R3–R7尚未完成。

新增UploadStore的私有SQLite reservation与独立immutable bytes root。每文件25MiB，actor/workspace最多256 reservations/
512MiB；transfer并发2。metadata含创建幂等键hash、conversation与原文件名/hash/长度，不接受磁盘路径。PUT逐块验证、
长度与SHA256一致、fsync后才给stored。临时文件每reservation固定exclusive staging，普通中断清理自己创建的临时文件；
崩溃遗留/另一进程持有的staging拒绝覆盖/删除，不按TTL接管。其人工恢复/GC及服务器数据删除仍待实现。

DocumentHttp使用现有产品auth/Origin/CSRF与binding，明确路由到上传、import/job、Library list/get和原件，不暴露generic
RPC。授权在异步步骤前后及原件输出期间重核；注销/断连撤销未完成传输。Stored不等于source eligible：现有Core
LibraryService→隔离Python ingest→Library事务commit才准入，失败原件不进入问题。显式重试queued/running import
可恢复确定性解析，保持原ingestedAt，避免已提交索引与新timestamp冲突；不牵涉重复模型执行。

相同bytes可复用Library revision；同名不同内容不自动覆盖。Upload candidate持久绑定conversation，不依赖会过期的
filesystem discovery临时结果。DocumentApplication可注入这一port，RuntimeManager装配每会话的DocumentOperations/
prepare/backend。提交refs通过已有canonical hash与精确native消费激活；打开原文、后台导入不改变正在执行的来源frame。

Live资料drawer支持上传、重试/继续处理、失败提示、Library分页与checkbox版本选择。选中refs与不确定submission一起
按tab/actor/workspace/conversation保存并锁住；刷新不自动submit。上传只存metadata/ticket，不存二进制或auth secret。
清本地上传记录明确不删除服务器文件。PDF.js source类型不再依赖DemoDocument，真实label与示例分开；限长取字节、
SHA256核对后render，移动端切换而不挤掉操作。原件preview不生成citation/selection authority，相关入口明确未接。

真实浏览器fixture把上传PDF交给namespaced sidecar，faux模型真正调用docatlas_sources→Flash merge tree→Read page，
记录模型最后输入含实际tree-page及原文15.2后保存checkpoint；打开同版PDF保留草稿，翻页/手机axe与无横向溢出验证。
另有foreign conversation/stale revision读原件拒绝，坏PDF不准入、保留草稿且零模型调用；上传wrong hash、中断、
跨actor/session、重开与篡改、orphan不覆盖均有阴性测试。Demo/旧Reader仍独立回归。
PUT成功但HTTP回执丢失后，刷新页面只保留原upload metadata，明确点击继续处理可完成导入；未重新触发模型或丢失草稿。

PDF.js worker/Wasm使用自托管资产，CSP精确增加self worker与wasm-unsafe-eval，不开放JavaScript unsafe-eval。新增
document-http schema以及Node/static browser/Python共同正反例。完整库catalog测试随新合同更新；不改旧RPC语义。
全量最终通过101 JS files、649 passed/1 skipped及206 Python；首轮新schema遗漏catalog集合已修正。并行browser负载下
旧native 800ms测试曾触发时限，停止并行压力后完整复跑通过，未放宽生产或测试deadline。原型14/旧Reader6/live6均通过。

仍待：用户真实PDF质量/视觉验收、结构化Answer/verified citations/selection票据、显式revision replacement/删除/GC、
@PDF/多入口及Compare完整UX、默认部署与崩溃监督、R4–R7。PageIndex在线main仍ae169566；本轮连接其实际merge
导航通路，没有虚称Flash算法新增。summary/expand等增强仍按Pi-governed explicit jobs门禁推进。
