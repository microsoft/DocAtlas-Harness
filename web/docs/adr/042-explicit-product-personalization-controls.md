# ADR-042 · 产品个性化控制与实际应用分离

> 2026-09-09 · Accepted for the local beta controls · 模型应用/自动学习尚未接入
> 后续进展：[ADR-043](043-ephemeral-personalization-application.md) 以独立 v2 产品合同接入请求级模型表达指导；本文件记录的 v1 语义保持不变，自动学习仍未接入。

## 决定

复用独立 PersonalizationStore，由 Core PersonalizationControls 和 host PersonalizationService 提供认证入口。
Profile 与研究库物理分离；Pi worker、Python、原生工作区和浏览器不得直接读 profile 文件，也没有模型画像写工具。

当前 local beta 的 profileId 为 `profile:pi:` + `SHA256(JSON.stringify([actorId, workspaceId]))` 前 32 位；
个人会话 ID 为 product conversationId。先验证 ControlStore binding，再由 host 注入 actor/profile/workspace/session。
`global` 在此仅指该个人工作区 profile 的全部任务，不宣称跨工作区共享画像。

新 `product-personalization.v1` 浏览器 DTO 不接受用户自填上述身份，也不接收自由文本画像、敏感等级或任意 apply policy。
首批只允许回答顺序、解释深度、术语解释、呈现形式、成果格式与比较排版六轴的显式枚举；Core 固定 ordinary/disclose。
preferred-representation 不接受 Markdown，原始 PDF citation 的约定不被偏好改写；Markdown 仍可以是个人记录的导出格式。

保留既有领域命令的 CAS、幂等、pause/resume/edit/forget/export。pause 不接受未兑现的定时 until；
单 memory-chain 的 forget 仅 memory-only，privacy-erasure 限明确确认的整个 profile，并呈现真实的备份/导出/外部副本边界。
`useExisting` / `contributeToFuture` 分别保存，不把关闭贡献误当作禁止手动设置，也不与研究 recall/contribute 合并。

最重要的产品状态区别：本批只是控制面已接通。HTTP 返回 `modelApplication: not-connected`，UI 明确显示“模型应用尚未连接”。
保存成功不是实际应用；why-used 只展示真正存在且能配对的 Decision/MemoryUse，没有记录就明确没有。
不为演示生成假的 MemoryUse，不因用户点一次偏好就推断熟悉度、身份或全局长期习惯。

未确认命令先在标签页按 actor/workspace/conversation 保存原键及 binding/generation；只有精确匹配的 receipt 才清除。
刷新不自动写入，旧代际的命令不换新 generation 重发。导出经同一 paired HTTP 认证，以 opaque assetId 获取，禁止任意文件路径。

## 下一依赖

下一步接精确消费时的 bounded preference decision、真实 MemoryUse、why-used、撤销/暂停后的行为，以及同事实/同证据下的
on/off 对照；再接单变量 Probe、观察候选/用户确认、纵向校准和纠正/遗忘。高影响阅读排序/反证深度仍须额外 non-interference gate。
不因本批设置界面可用而把“越来越懂用户”或全部 R4-004/005 标成完成。准确验证见[任务板](../execution-tracker.md)。
