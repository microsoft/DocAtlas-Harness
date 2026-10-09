# 可交互研究工作流：Compare、Note/Recall 与偏好控制

> 2026-09-09 · 加速交付 B 的实现记录；不是完整目标完成声明

本批按三个不重叠的代码责任并行：A/B Reader 与 Notebook UI、Core/Pi Record/Recall 与真实存储验证、偏好适配/共享 fixtures/UI。
主线程负责身份/契约、Core 授权检索、产品服务/原文 resolver、浏览器 client/装配和统一构建验收。没有重新调研或扩展非阻塞 Flash 选项。

## 实际改变

- Compare 的 A/B 各自持有 exact source revision、页、zoom/scroll、选区和 24 级有界返回栈；窄屏切换同一状态，不用页码硬同步。
  用户新动作会使旧 citation/Library 请求失效；共享 PdfReader 增加可选 viewState/restoreToken，默认原型调用保留原行为。
- Core ResearchOperations + Pi optional facet 接入 Record/Recall；新的私有 provenance 只负责执行归属，已有 Investigation journal
  仍是记录真相。无文档输入有真正空 capture，且延迟到研究工具使用时持久化，不沿用前一轮文档 scope。
- Notebook 可保存已核验选区及来源、跨会话查看、获取全文/CAS 编辑、归档/软删除、重新打开同版 PDF；独立研究开关。
  选区保存当前通过已核验的问题托盘进入，独立 Note 选区入口仍待，不将其说成已完成。
- 查询前检查原会话和来源权限，隐藏未关联 provenance 的 Agent orphan；关联源被撤销/替换不通过缓存笔记泄露。
  exact source-scope 和 note ID 查找加 JSON expression index，避免每条旧研究都全量扫描 journal；旧 v5 schema/默认 DSH 行为保留。
- 个人偏好单独持久化/认证，支持显式枚举/CAS/暂停恢复/忘记/导出/双开关。模型应用和自动学习未连接，界面/合同明确表示。
- 新命令的三端 shape/semantic fixtures；回包丢失保留原键，刷新不自动重复写。Drawer 的键盘循环补 select/summary，并排除禁用控件。

## 有意保持的边界

Recall/Note 是研究线索，不是新 Evidence；位置能核验不意味着 Note 的解释正确。重读旧源和源范围纳入仍独立，偏好不参与事实支持。
Record/Recall、浏览器研究命令和 profile controls 不进入第二条 Agent Loop，也不把 Python 变成记忆宿主。
默认首页仍是聊天，重模块按需打开。原 DSH 和模拟原型保留，未修改 .sources、sibling 或迁移用户旧数据。

PageIndex main 本批再次在线核对为 `ae169566b3148792776531d987f543edcad92321`；上一批 raw/merge 与显式 summary/expand/full
overlay 继续保留。本批不虚称发布了新的 Flash 上游提交、完整质量优化或所有 provider 验收。

## 验证

完整`bash scripts/check.sh`已过：1378 JS passed/1既有skip、705 Python passed，以及全部构建/合同/兼容/打包校验。
实际Pi跨会话记录/正常重开/召回验证只使用4次faux model calls，没有旧请求重放。浏览器首轮暴露了Note nonce格式、
首建4000字边界与lifecycle scope字段的接线遗漏，均已修；Notebook两个真实流程复跑通过，最终live16、原型14、legacy6，共36/36浏览器测试通过；精确命令见[任务板](../docs/execution-tracker.md)。
测试中默认开关假设与Chromium响应缓存读取问题独立修正；中间一次build重叠的旧validator/缺失dist检查在构建结束后重跑，
没有放松原断言或加自动重试。浏览器用真实 PDF/HTTP/存储/隔离 Pi，但模型为 faux，不等同真实模型的长文/记忆效果评测。
新决定见[ADR-041](../docs/adr/041-product-research-and-capture-scopes.md)与[ADR-042](../docs/adr/042-explicit-product-personalization-controls.md)。
