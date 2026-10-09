# DocAtlas Web：简洁入口，完整研究工作面

> 2026-09-09 · 当前产品规格；实施状态见 [任务板](../execution-tracker.md)。
> 承接 [Web 全景调研](../../research/16-web-ui-interaction-design.md)，覆盖其 DSH shell / 强制三栏选择。
> 本页描述完整目标；[Prototype 01](prototype-01.md)保留独立模拟模式。本机Pi live已接原件/选区/Compare、Notebook/偏好、人类Claim/Review本地成果与显式版本/Continuity；完整质量/恢复/部署未验收，不把目标表整体当作已实现。

## 1. 产品原则

DocAtlas 是以研究对象为核心的通用 Agent 产品，不是 Coding Agent 控制台，也不只是 PDF Chat。
默认只展示当前任务需要的界面；所有关键能力可到达，不靠删工具、隐藏报错或复制宿主 DOM/CSS 来实现简洁。

- 首屏：居中的聊天输入区，附件/文档选择入口，简短提示；历史/设置用轻量折叠菜单。
- 对话开始：自然过渡到聊天流，保留输入、附件准备状态和停止/继续能力。
- 点击引用：打开原始 PDF 与旁边的同一对话；自动定位到证据段落，只有验证通过才画高亮。
- 主动打开资料：用户可随时从附件/资料库进入原文，chat 保持在旁；不是必须等待模型引用。
- 深入研究：需要时才展开 Notebook、Compare、Claim/Review/Publish、个性化，不默认堆七个面板。
- 通用任务：代码、终端进度、diff、图表和输出文件有对应工作面；文档规则不锁住原生 Pi 能力。

## 2. 布局状态

| 状态 | 主区 | 次区/控制 | 保留状态 |
|---|---|---|---|
| Empty | 居中 composer，建议宽度约 680–760px | 添加资料、历史、设置 | 草稿与待上传队列 |
| Chat | 限宽聊天流 + composer | 折叠 activity、文件/来源 chips | 消息、输入、run/queue |
| Read | 原始 PDF 主区 | 同一 chat 侧栏；目录/文档列表可折叠 | chat scroll/draft、source revision/page、选区 |
| Compare | A/B 原文，各自 cursor | chat/比较结果按需侧栏 | 两套 exact source identity，不按页码硬对齐 |
| Research | Notebook/Claim/Review/Artifact 工作面 | 来源 peek/原文、chat 保留 | 同一 investigation/domain IDs |
| Narrow | 一个主工作面 + 清楚的返回/切换入口 | 可切换 chat/PDF，不挤成三列 | 共用状态，不创建第二会话/第二消息流 |

Read 初始可用约 60% 原文 / 40% chat，允许拖动和恢复用户选择；不是锁定尺寸。关闭 PDF 回到原对话位置。
Prototype 01 当前默认 58/42，支持拖动、方向键、双击/Enter 重置；布局调整后重新解析高亮坐标，但不抢键盘焦点。
布局比例仅是当次工作面状态，不隐式作为个性化学习信号。
每次 navigation 保存 source/citation 返回栈；Agent Read 默认不改变用户滚动位置，follow 明确开启后才跟随。

## 3. 视觉语言

- 暖白/浅中性底、深灰文字、单一低饱和蓝色操作色；证据定位用柔和黄色/琥珀色。
- 有限边框与阴影，避免彩色卡片墙、渐变装饰和每个按钮不同颜色。
- 正文有稳定行距/阅读宽度，中文与数字表格可读；长 source 名称允许截断并可展开完整身份。
- 当前原型正文 15px / 分屏 14px，主要辅助文字 11–12px，手机输入 16px；不依靠大面积低对比度小字制造“精致感”。
- 高亮、错误、冲突、成功不只靠颜色表达；有标签、icon/边框和可访问文本。
- 常用操作可键盘触达，重要 touch target 约 44px，支持 reduced motion；对比度按 WCAG AA 验收。
- 不把系统提示词/隐私上下文/完整模型推理过程当默认聊天内容；原生模型、成本、运行状态和诊断入口仍可见。

这些是待视觉回归和用户评审的 token/行为基线，不是一次性生成大套 UI 的理由。

## 4. 逐句出处的准确语义

material factual span → Claim/Evidence/Derivation，而非随意在一段末尾放一个页码。

- 直接事实：指向已读取并校验的 source revision + Locator。
- 计算结论：展示输入来源、计算/代码活动和产出，不冒充 PDF 原句。
- 综合判断：列出依据及不确定性，不假装存在一段完全相同的原文。
- 建议/连接语/一般任务：不强制伪造文档引用；显式区分任务性质。
- 缺失/未核验/冲突：有状态，不能因为文本流结束就变成已支持。

一句包含多个事实时分别挂引用；多来源引用可在小列表中选择正确 source，不默认跳第一个。
hover/键盘 focus 可预览引用原句、文件名与页码，Esc/失焦/滚动关闭；点击仍直接导航，不要求先点开卡片再点第二次。
正式产品的预览同样受 source 权限与 revision 状态约束；不能拿过期的客户端缓存摘录绕过授权。原型只预览内置样例。
流式阶段尚未确认的引用是 pending，不可点击跳到猜测的位置。最终 AnswerManifest 与运行/消息/证据 checkpoint 对齐。

## 5. Citation → 原始 PDF 状态机

```text
点击 material span/citation
→ 服务端授权 + re-resolve exact document/revision/representation/Locator
→ 打开原始 PDF 页（不是 markdown）
→ 校验 displayed page identity 与真实 geometry
→ 高亮确切区域 + 可访问焦点 + 返回回答锚点
```

结果分 exact / page-only / ambiguous / stale / missing / forbidden / unavailable：

- exact：画真实 line/paragraph/table/figure 区域；可查看原句上下文。
- page-only：只到原始页，明确“尚无法精确定位段落”，不画猜测框。
- ambiguous/stale：保留原因和可选择候选/重新核验动作，不能假装最近字符串就是原文。
- forbidden/missing：不显示缓存摘录替代已失去权限/不存在的原文。

PDF 渲染引擎可以沿用受控 PDFium bitmap 路径作为基线；是否改 PDF.js 是后续 renderer 决策，不改变原文权威。
文本层用于选择/辅助访问，但引用高亮只发生在原始 PDF。Markdown 是明确选择的衍生视图，不是 citation 默认落点。
旋转、CropBox、多栏、重复文字、OCR 对齐、跨页段落单列 geometry tests；不能无条件从文字相似度生成坐标。

## 6. 上传、@文档与多文档组织

用户理解的是资料和研究，而不是 SourceScope 内部 API。

1. 上传/选择/@引用形成一个显式纳入意图，服务端统一执行准备。
2. 展示准备状态：已接收、可阅读、可检索、目录/摘要就绪或失败；原文可看不代表解析全部结束。
3. 必要准备失败时保留草稿和附件，不启动无法访问文档的 Agent。
4. 相同名字用来源/集合/版本消歧；不能用 basename 猜文档，也不把浏览器输入当服务器路径。
5. 多文档组织保留 Workspace/Investigation、Collection/Series、revision 的不同含义。
6. “已选资料”“本轮已读”“回答引用”“历史研究建议”分开显示；未加载的资料不因分页被 scope patch 清空。
7. 已在 Library ≠ 已纳入这次调查；用户明确上传/选择可完成纳入，旧 Memory 不可静默扩大 scope。

Library 搜索/筛选/批量选择、版本历史、Series、Compare/Matrix 属于同一领域模型。Collection/Series 的尚未实现
部分在任务板标 deferred；不能因为新首页简洁就从方案删除。

已接的「版本与更新」从资料卡按需展开，显示精确revision、历史原始PDF及A/B/提问勾选。
上传到同文档必须明确目标并固定预期当前版本；保存后不自动替用户切换提问来源。原bytes保留，历史引用继续打开旧版原文。
刷新版本与状态是只读；未知操作保留原目标/前驱/body/key，显式原键继续，不能以最新状态重写旧请求。

## 7. 选区与主动阅读

第一层 toolbar：问 Agent、解释、保存笔记；展开提供对比、翻译、计算、找反例/提出问题/Claim proposal。
选区可以是文字、多段、表格单元或图像区域，按 provider 能力开放。

- composer 显示有身份的 context chip：文档/版本/页/选区，不靠模型理解“上面那一段”。
- 默认 one-shot，pin 是明确操作；可移除、重排、查看来源。
- one-shot 明示“仅本次提问”；卡片默认紧凑，展开才看完整片段和来源，支持不发送就返回原文。Ask 后焦点留在 composer。
- 发送时服务端重新核验 hash/scope/Locator，all-or-none claim；nonce 不进入模型/持久日志。
- 失败、取消、queued steering、重复点击、断线重试都不能把选区附到另一条消息。
- Ask 不自动写 Note 或长期 Memory；保存/评论/问题/Claim 是明确的独立命令。
- annotation → Note → Evidence → 原始 PDF 必须可往返；无证据 commentary/hypothesis 不伪装成已核验事实。

## 8. 重模块如何进入界面

| 能力 | 自然入口 | 核心交互 |
|---|---|---|
| Notebook / 研究记忆 | 保存笔记、继续之前研究、资料旁注 | Note/Question/Decision/Policy 分型、编辑/归档、回原文 |
| Claim Ledger | 回答的重要结论、研究面板 | support/refute/qualify、版本、反证/冲突、coverage |
| Review | “核验此结论/比较变化” | checklist、issues、原文/推导、human accept/reject/sign-off |
| Artifact / Publish | “生成交付成果” | Brief/Matrix，固定 ClaimVersion、引用覆盖、审阅后发布 |
| Continuity | “与之前相比”“继续这个问题” | continuing/changed/conflicted/unknown；历史线索先重新读原文 |
| Personalization | 轻量 why-used、设置、低频 Probe | 偏好范围、解释、修正、双开关、暂停/忘记/导出 |
| Native Agent work | chat activity/输出文件/命令面板 | shell、diff、代码、模型、上下文、分支、队列、人机交互 |

这四类信息不要混在一个“Memory”抽屉里：Sources（原文）、Related prior work（旧研究）、Why personalized
（用户适配）、Agent Activity（执行）。研究积累是独立价值，不强制归为个性化。

### 当前已接：结论与审阅

[ADR-045](../adr/045-local-human-review-workbench.md)通过顶部「结论与审阅」或回答下的「整理结论与证据」展开工作面。
界面分为「证据与结论」和「成果与审阅」：原Evidence预览/原件focus、显式关系/输入/Claim状态与CAS修订，
再将固定ClaimVersions组织为Brief/Matrix、材料核对声明、G0–G4、独立人类决定和本地不可变发布。
证据预览是有界显示，不取代canonical Atom；成果不具备证据权威，引用保持原PDF落点。

历史scope是本次人类workbench的明确选择，不自动修改native对话源准入或selection消费。
来源失权、旧conversation不再可访问或Answer没有同一completed checkpoint publication时，不以缓存/Note补出处。
截断/无范围/加载失败有真实提示，不能生成Demo记录填空；核对声明不声称穷尽外部材料。

人工批准不能更改G0–G4结论；发布看该Review最新journal追加顺序决定，不能按时钟/ID挑旧批准。
已经发布的固定内容不能原地回滚；当前复制修订会创建新成果链。后续拒绝不删除旧发布，原body/key只用于对账已有receipt。
页面中的未知请求保留actor/workspace/conversation/binding/generation/scope与原body/key；刷新不自动执行，
切换范围不重新定向请求，只有匹配的持久回执或显式本地discard清除。迟到响应不能污染新身份或清理新草稿。

此工作面保留简洁首页，并不增加模型自动签署、Continuity、自动学习或外部发布；表达式存在/G0–G4通过也不是算术或语义正确性证明。
actual HTTP/Pi和新增browser定向旅程已通过，身份race与最新Review顺序已补回归；完整browser/业务验收仍以任务板为准。

### 当前已接：继续核验

[ADR-046](../adr/046-explicit-revisions-and-continuity.md)从已保存Note、精确ClaimVersion或ArtifactManifest打开独立工作面，
不在首页增加常驻面板，关闭原抽屉但保留其未保存草稿。页面区分原研究依赖、明确选定的已完成Read范围、两侧Evidence、
只读版本依赖检查和人类判断。旧来源可由用户明确加入下一问题，但该操作不发送问题，也不自动学习偏好。

本次来源默认空选，不根据新旧/文件名/ID猜测；没有双侧完整材料时不能选择comparative状态。
每个Evidence都有原始PDF定位入口；打开原文后返回保留两侧选择和判断草稿。历史范围省略不等于当前证据不完整，分别提示。
判断固定原record version/owner/body/key；刷新只读、不重放，原键核对才可能提交或返回原receipt。
保存结果显示真实ContinuityLink与固定旧版本，不覆盖旧研究/出版内容。自动语义diff、全面影响发现与完整恢复继续单独验收。

## 9. 个性化与受控 Probe

沿用 observation → candidate → policy/confirmation → memory version → bounded decision → use/outcome → correction。
优先呈现/解释深度/术语熟悉度等低风险效果；source order、reading plan、challenge depth 的高影响作用面继续 gated。

两种答案样式必须共享事实、Evidence、scope、不确定性和冲突集合，只改变一个 axis；随机左右顺序，支持都可/
都不合适/跳过，并明确本次/工作区/任务类型/全局范围。一次选择不直接变成全局偏好。已有“每 investigation
最多一次”的上限不是已证明合适的频率；自动触发要经过真实用户校准。个性化不能把 PDF 默认引用改为 Markdown。

2026-09-09本机beta状态：六轴显式设置与许可已接host临时表达指导，Drawer区分保存/实际生成使用/未知效果；
不是自动学习或Reader布局执行器。变更可能中止正在使用旧偏好的回答，用户明确发送新问题才继续；贡献开关和导出不触发撤销。
偏好原键outbox保留v1/v2请求版本；旧协议不静默重写。依据[ADR-043](../adr/043-ephemeral-personalization-application.md)。

用户主动的首个Probe已按[ADR-047](../adr/047-controlled-presentation-learning.md)接入保存回答下的「比较两种呈现」。
同一完整回答、证据和弱/未知/冲突信息只交换整节顺序，两卡其他样式相同，侧序由host冻结，不再生成两份答案。
先明确准备，再选A/B/都可/都不适合/明确跳过；打开/关闭不算信号。默认仅本次；明确工作区选择也仅产生pending候选，
需要另一步确认。相同范围已有偏好不自动覆盖，用户可到偏好中心编辑；没有自动全局偏好或弹窗。
贡献开关门控新信号，使用开关控制之后的问题；过去合法选择可在opt-out后读取/确认。只读刷新、原键重放、profileEpoch与原Answer
绑定都可见，完整原文不存进偏好/outbox；引用仍只回原始PDF。其余轴、自动触发与纵向效用仍按目标逐步验收。

## 10. 运行中交互与失败

显示可理解的 action 和必要进度，不直接展示隐藏推理链。保留原生 model/reasoning/queue/branch/compact 控制，
但集中到轻量菜单/工作面。steering 标明已接收、排队、生效，不能暗示会中断当前工具 batch。

已实现的设置/历史见ADR-048，手动压缩见[ADR-049](../adr/049-manual-native-compaction.md)：入口保留在「运行设置」抽屉，不给首页增加常驻技术面板。允许可选保留说明，只在实际空闲且有可压缩内容时开放；明确模型调用/摘要可能省略内容、完整历史与PDF引用保留、不是Memory或隐私删除。成功显示原生压缩记录，已证未应用与未知结果分别提示；原键恢复、停止等待和未提交问题草稿不相互覆盖。分支/fork、复杂自动压缩/steer出处与完整扩展UI仍是待交付能力，不把占位按钮当实现。

等待用户、处理中、retry/compact、取消中、结果未知、已结束是不同状态。所有 approval/extension UI 有关联 ID、
取消与过期处理；TUI-only 扩展明确说明。运行模型、显式 Bash、Python 和 child jobs 的取消都由 product coordinator
统一处理；刷新恢复不会重复执行计算、发布或外部写入。

## 11. 真正的验收场景

1. 首次上传示例 PDF，发问、点击引用、原始段落高亮；常驻 composer 第二问同样成立。
2. 主动打开 PDF、跨页选择后追问；移除 chip、取消、重发和 queued message 不串线。
3. 两份同名文件/同页不同内容/不同 revision：正确消歧与 Compare，无 wrong-source highlight。
4. 财报→Python 计算→图表/Excel→derived claim→原文/代码可追踪。
5. 论文→代码修改/运行→研究笔记；原生 Pi 编程能力未退化。
6. 旧研究召回→显式准入→Read reverify→新旧结论变化；权限撤销/旧源失效不会用旧 Note 代替证据。
7. Claim→反证→Review→人类决定→发布 Brief/Matrix；格式合法不等于事实正确。
8. 个性化 on/off 与单变量 Probe 不改变事实/证据/冲突；pause/forget/reload 可验证。
9. refresh/reconnect/首响应前服务崩溃/取消 Python 或 Bash/切换分支后迟到事件，全都诚实恢复。
10. 中文、扫描、多栏、表格/图像、旋转、超长 PDF、窄屏、键盘、屏幕阅读器与大结果预算。

现有 fixture browser tests 作为回归输入；必须另有真实 product server + Pi loop + document service + PDF 的
验收。截图、样式测试、单独 reader demo 都不能替代以上流程。
