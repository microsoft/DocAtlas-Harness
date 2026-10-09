# ADR-058 · 安静的聊天、连续原文阅读与目录导航

状态：有界实现已部署并通过核心浏览器回归；视觉仍待用户确认。只优化本机真实Web体验，不重做Agent Loop或来源授权。

## 设计依据与取舍

按用户要求，使用find-skills查阅skills.sh及原仓库，完整阅读Anthropic frontend-design、ui-ux-pro-max及其quick-reference/pro-rules。
后者的首次“document research reader minimal”结果误路由至Marketplace，不采用；收窄为“knowledge base documentation”后，采用其Minimalism、灰白底/蓝色交互、清晰文字层级与按需导航原则，不照搬FAQ营销页。
React虚拟化与UX reduced-motion检索支持窗口化长列表、少量含义明确的动效和稳定占位。原项目为React18，不能因为指导数据标注React19而升级框架。

参考：[Frontend Design](https://github.com/anthropics/skills/tree/main/skills/frontend-design)、[UI UX Pro Max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill)、[skills.sh](https://skills.sh/)。仅临时研究checkout，不安装全局skill、不引入远程字体/图片。

## 统一视觉与布局

按追加要求：真实Web首次默认英文，右上角EN/中文切换，本机仅保存UI语言键。不重建会话/阅读器，不改变模型语言、原文、用户输入、历史回答或个人Memory；中文原型保持独立。
本批翻译首屏/聊天、资料、引用、连续Reader、目录、选区和历史主流程及高级模块入口；旧研究/治理工作台内部仍有较长中文说明，其全面翻译单列后续，不以“切换按钮已接”声称整仓文案翻译完成。

- 颜色：paper `#FFFFFF`，canvas `#F6F8FA`，ink `#24323D`，muted `#657381`，accent `#426783`，line `#E3E8EC`。黄色仅用于原文证据高亮。
- 字体：保留自托管Noto Sans SC与系统无衬线；正文16px/1.8，聊天正文最大720px，标题分层但不做广告式hero。
- 首屏仍为居中输入。进入对话后，用户消息右对齐轻底色，不再逐条显示“你/生成中/已保存”；回答为左对齐开放正文。
- 支持引用默认为紧凑编号；反驳/限定保留额外符号、accessible name与说明，不以颜色单独承载关系。点击仍核对同版原始PDF。
- 活跃状态使用一个小型呼吸/圆点动画，处理详情按需查看；失败、取消、未保存与断线仍明确可见，不用动效伪装成功。
- 阅读模式：`聊天 | [目录（可收起）] 原始PDF连续页`。对照阅读保持A/B独立位置、选区、来源；窄屏保留可切换的对话与阅读面。
- 150ms控件反馈、220ms面板进入，仅transform/opacity；reduced-motion静止呈现，不依赖animationend提交业务状态。

## 阅读器与性能边界

连续阅读使用一个滚动容器和可见页窗口，只挂载当前及相邻少量canvas/文字层；远页留稳定高度，不一次绘制整份文档。
加载时优先当前目标页；缩放/尺寸变化重新绘制窗口，不重新下载原件。页码随滚动更新，但不推入历史或自动改变提问范围。
引用与选区始终对应其真实物理页；打开目录/翻页是导航，不是Evidence，也不触发模型或新增增强作业。
目录使用已有授权tree读取接口，固定document/revision/hash/generation和分页，迟到响应不能覆盖新文档；空树诚实解释，保留页码导航。

不跳过原件字节/哈希检查、不降级权限、不用全局无界PDF缓存。服务端resolve时间与浏览器渲染时间分开测量，不把动画当作真实加速。
静态服务在启动时对固定白名单JS/CSS预压缩Brotli/Gzip，按Accept-Encoding协商、Vary及精确长度发送；不压缩PDF或API正文，启动内存仍受64MB总预算约束。
原型保留原Reader；真实Web采用连续Reader，共享来源类型和精确文本匹配。窗口/当前页/滚动位置只属前端临时状态，不改持久合同。

### 连续页文字层修复（2026-09-11）

用户反馈PDF下方出现类似Markdown的重复文字。实际根因是透明文字层样式只匹配当前页的`pdf-text-layer`，
相邻页保留`pdf-page-text`却没有透明、逐字定位与裁剪样式，PDF.js文本因此作为可见普通文字泄漏。
两类文字层现在共享完整样式，不依赖当前页状态；原PDF是唯一可见正文，不增加Markdown视图。
文字层仍可选择/复制并供引用范围定位，不使用`display:none`、`visibility:hidden`或禁用选区的方式遮盖问题。
回归覆盖相邻页、翻页后原当前页、缩放和窄屏，另核验选区问答及原PDF引用高亮；精确结果见任务板。

## 验收

真实PDF上传→提问→编号引用→高亮、连续跨页、页码与目录跳转、返回位置、缩放、A/B与选区授权；桌面和375/390px、reduced-motion、键盘与axe。
记录首屏脚本、原件请求次数、挂载canvas上限、首幅渲染/引用解析分别用时。合成PDF自动测试不冒充任意语料或人工视觉验收。
改动前同一本机实际会话冷浏览器：入口约778ms；首个引用到高亮约5101ms；主live脚本实际传输3779096字节。不同运行/网络不能据此推断通用加速比例，最终指标另记任务板。
