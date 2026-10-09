# Core document application 与真实 Pi 数据链

> 2026-09-08 · 第五批；完整目标 active。设计见 ADR-027。

## 实际迁移

LibraryService、source-scope registry/binding 移入 Core/document；Node LibraryDiscovery、asset access/URL、supervisor
移入 runtime-document。旧路径只做 re-export，保留 DSH subprocess adapter/Connection，未改旧 wire/event/store schema。
Core 仅依赖 contracts；runtime-document 仅依赖 Core/contracts/Node；Pi-specific tools 保持在 runtime-pi。
source-scope.ts SHA 前后相同：17eaceb1a82a95a3124d25db4be6940a7121449d78de358d7feb123c10908e84。
Library/asset/supervisor 除 imports/ports 提取外的行为改动分别记录，不用该 SHA 代表它们完全未变。

## 应用闭环

内部 DocumentApplication 使用 ControlStore 的 actor/workspace/conversation owner 绑定。Library import 复用真实 discovery、
hash、版本/dedupe、ingest 与现有持久 store，不是重新写个测试 importer。Doc session 把 sourceRefs 变成持久 scope snapshot。
准备排队消息不激活它；只有 Pi exact native message-consumption callback 才切换当前 frame。
source-scope 中的逻辑 session key 是产品 conversation；Pi native session ID 仍独立校验，未伪造 DSH session/event。

逐次操作检查 owner/generation、eligible representation/hash、policy exclusions；异步返回再检查，拒绝迟到旧 frame。
同一 Investigation 的第二会话从已有 scope version 继续，不重置版本、不改变另一会话正在使用的快照。
每会话单独 document backend/supervisor，Library import 单独进程；取消一个会话不会杀掉另一个会话的读取。

## Pi 工具与实测

新增 docatlas_sources（分页）、docatlas_search、docatlas_read、docatlas_tree；保留原生工具和 defaults。
Read 包含 locate、blocks、expand、sequential、visual、physical-page。树只是导航，不替代证据；文字与图片返回均绑定
实际 document/revision/representation hash；PNG/JPEG bytes 再验 SHA、长度、页码/尺寸，非路径字符串或假占位图片。
用已有 tool-meta.v1 返回 locators；未制造 EvidenceAtom、DSH event 或假 durable read receipt。

真实集成测试运行公开 Pi SDK 和其明确的 faux provider：一轮含 10 个实际工具结果，覆盖 sources、Flash merge、search、
六种 Read 和原生 Bash printf，最终 native checkpoint 持久完成；视觉结果 byte hash 与真实 sidecar asset 一致。
这是执行/身份/存储证明，不是模型推理或回答质量证明。测试图片/PDF 是已存在的六页合成报表，无私有文件或付费模型请求。
另覆盖 all-or-none、prepare/consume 顺序、迟到结果、取消/重启、跨会话取消/旧 native session、foreign owner、
伪造 representation hash、改动图片 bytes、policy exclusion、shared Investigation。

## 额外发现

旧 supervisor 在 await spawn 时 dispose，可能在关闭后重新启动；现在用 epoch fencing，并等待迟到进程真实退出。
两个专门测试覆盖 dispose 在第一次 await 前/异步 spawn 中两种窗口，旧 supervisor/Library 回归保留。

上一批 Python wheel 已包含 Flash 数据，但旧 plugin npm files 白名单只包含 .py，漏掉 vendor JSON/License。
本批补齐，verify-packed-flash 实际 pack 后逐一检查81个算法/数据/许可证文件及provenance（共82），不再仅看工作目录。
尝试 bundledDependencies 被当前 pnpm isolated linker 明确拒绝，已撤回；未为打包改变 workspace linker。
私有 workspace packages 的独立 NPM 安装/发布策略仍属于 R7，不用 tar 内容验证冒充部署验收。

## 未完成

公开 auth/HTTP/Web、上传与选区所有入口、Answer/Evidence 持久编译与原始 PDF UI 闭环、Record/Recall、完整 ingest/read
进程/模型/扩展隔离、更多真实质量/长文/跨平台验收与 R4/R6/R7。新 Node launcher 仅有 env/process-group 管理；
不能把 Flash 的局部 namespace 安全证明外推到整个 Python sidecar 或 Pi 产品。未迁移用户数据库。
