# PageIndex Flash 与 SDK：采用边界和验证计划

> 研究复核：2026-09-08。
> 当前本地 source pin / 本轮在线 main：`ae169566b3148792776531d987f543edcad92321`，已按用户要求更新。
> 旧 pin `9fee239b174fcc205fec28df105e519ac7171522` 到当前提交间 Flash 文件未改变，主要是 SDK/chat/integration 更新。
> JS SDK：`9925e8a347a9985424f4bb4e95718a75814b9b67`。
> 2026-09-09在线复核仍是这两个main，无新算法升级；Python稳定release 0.2.15已经在pin中，JS main有npm0.8.0未发布的API。真实scope差异、benchmark范围及本地有界并发后续见[复核38](38-pageindex-sdk-followup.md)。
> 后续已落地：[内部provider/generation/raw复用](22-flash-provider-and-generation.md)、[显式Pi增强作业](../docs/adr/038-flash-enrichment-jobs.md)及[有界并行v2](../docs/adr/053-bounded-parallel-flash-enrichment.md)。下方早期探针、采用计划和2026-09-08矩阵保留为历史，不代表当前能力仍未实现；最新实现/验证范围见文末。完整质量、默认provider与恢复gate仍未关闭。

## 已确认

[Flash](https://pageindex.ai/blog/pageindex-flash) 的结构提取使用 PDF layout/text/bookmarks，代码位于
`.sources/pageindex/pageindex/flash/`。`summary=False, optimize=False` 无模型；`optimize='merge'` 不做 LLM expand，
但如未关闭 summary 仍会调用模型。默认 full + summary 不是离线无模型流程。没有 OCR，扫描/图像密集文件需
另一个 provider。远端摘要模型仍收到文本，因此“local index”不等于所有数据零外发。

DocAtlas 当前 `docatlas/preprocess/build_tree.py` 调用旧 vendor 的 `page_index_main`，并未采用 Flash。
产品 sidecar 的快速 FTS/Block Map 也不能等同于原生 DocAtlas 的 reasoning/tree 检索，应保留二者差异并测质量。

## 已完成的无模型 smoke（前一讨论轮）

CPython 3.12.12 / uv 0.9.21，调用 `page_index_flash(..., summary=False, optimize=False)`；禁用 dotenv，
测试进程 audit hook 阻止 socket connect/getaddrinfo。通过 uv 临时补充 sortedcontainers 2.4.0 和 PyPDF2 3.0.1，
未改项目 manifest/lock 或 research checkout。首次 import 约 1.58 秒，不计入下面的建树时间。

| 现有 PDF | 页数 | 秒 | 节点 | 非法页范围 |
|---|---:|---:|---:|---:|
| `DocAtlas-Harness/data/sample_report.pdf` | 6 | 0.432 | 5 | 0 |
| `q1-fy25-earnings.pdf`（PageIndex examples） | 22 | 1.425 | 28 | 0 |
| `attention-residuals.pdf`（PageIndex examples） | 21 | 6.516 | 34 | 0 |
| `2023-annual-report-truncated.pdf`（PageIndex examples） | 50 | 3.749 | 55 | 0 |

此表不是旧算法对照、检索 benchmark、完整 ingest 延迟或当前产品能力。四个 raw tree 均不含段落 bbox；树
range 正确也不证明层级/召回/语义质量。实验没有测试 >=64 页的自动 process pool。

## SDK 借鉴与不可照搬

- Python client 将 index 与 chat 分开；可提供 tools、instructions 和框架 adapters，不强迫采用其 chat loop。
- JS SDK 是 Cloud REST/MCP client，不能替代 Python 本地 Flash；local/cloud 的 OCR、line citation、folders 等
  capability 不同。Cloud 是单独 opt-in/数据边界，不是自动降级路径。
- tool schema、executor、guidance、management 权限分离；分页和明确 next_steps 值得保留。
- local page 结果与 Flash tree 来自不同 parser；DocAtlas 要保持 representation identity，不能假定坐标/文字可互换。
- 页级 citation 和约 100k-char response cap 不满足 DocAtlas 精确/有界读取要求；保留五 mode + verified Locator。
- 新 `ChatStream.events` 将过程与 text view 区分，同一次 run 只能消费一种 view；借鉴 typed events，不能为了
  两种 UI 展示运行两次模型，也不能把不裁剪的原始大工具结果全部广播给浏览器。

## R5 采用方案

1. 新增可选 Flash provider，不直接替换旧 vendor。source hash + generator/config 构成 index generation。
2. 先提供 raw/deterministic tree，保持原始 PDF/可读内容先行；摘要/expand 是可观察、可取消、有预算的独立作业。
3. 设 CPU/memory/worker limits。当前公开 `page_index_flash` 不暴露 worker 参数，而内部 parser 对 >=64 页可
   默认使用 CPU count - 1；生产接入前必须有受审查的并发控制，不能直接在大机器上无界 fanout。
4. Flash 内部 block/line/char geometry 可作研究输入，但官方仅保证 public tree API。若提取 geometry，单列
   provider contract、坐标系/rotation/reading-order tests 和 upstream patch provenance。
5. raw/optimized tree 保持 immutable generations；研究 overlay 和 Evidence 不因 node_id 重编号而错绑。
6. 同批原文/问题对照旧 tree、Flash raw、merge、full：ready time、CPU/RSS、LLM cost、section/page/block recall、
   citation precision、coverage、missing/ambiguous/rotation/OCR。中文、多栏、无书签、超长/混合 PDF 必测。
7. 只有质量与运行限制达标，才按 document capability 将 Flash 设为默认；失败继续可读、可 search，不假装有树。

采用 SDK 依赖或提取有限源码都要审查依赖闭包、MIT attribution 和后续更新；本次没有移植代码、安装整套 chat
依赖或调用 PageIndex Cloud。对应正式队列见 [实施计划](../docs/implementation-plan.md)。

## 2026-09-08 更新后的能力采用矩阵

以下是当时的采用状态；后续内部实现进展见文末与正式实施计划，不能将历史“待接”当成当前状态。

| 上游能力/变化 | DocAtlas 的处理 | 当前状态 |
|---|---|---|
| Flash raw layout/text tree | 原文先可看，树以独立 generation 发布 | 内部opt-in已实现；Pi/Web待接 |
| embedded TOC 深/浅书签融合、坏书签过滤、标题修复 | 加有书签/稀疏/乱码/错误书签质量集；保留 toc_source，不将书签当 Evidence | 本版本已有能力，纳入验收 |
| deterministic merge + 可选 LLM expand/summary | raw/merge 已实现且merge复用raw；增强仍需Pi显式job | 不采用默认 full+summary 隐藏调用 |
| >=64 页的 PDFium process pool 与 Type-3 fallback | 在真实长文件测 worker/CPU/RSS、顺序等价与取消；需要受控 worker 参数/patch | 仍是生产准入 gate |
| ChatStream 单次 run 的 events/text view、部分消费与中途错误修正 | 借鉴 typed observation/真实 error；产品用 Pi 同一次执行生成投影 | 不引入另一 loop |
| MCP 多模态结果由框架原样呈现 | 保留 text/image 类型和失败语义，同时执行 DocAtlas 更严格预算 | 后续 Pi document tool bridge |
| 过程显示隐藏 base64、减少终端噪声 | activity 只传有界元数据；图像走受权 asset，模型 content 独立限额 | 后续 browser projector gate |
| SDK protocol 参数、配置传递与 notebook | 参考接口清晰度与可复现实验；不照搬供应商协议/Chat API 到 Core | 已审阅，非运行集成 |

此次已完成源码 pin 更新与差异核对，**没有**宣称新版本使构树更快，也没有把未接入能力标成已完成。

随后新增 [有界 Flash 探针](20-durable-inbox-and-flash-probe.md)：以 pinned internal extract_toc(workers=1) 检查资源、
hybrid 书签融合、忽略书签一致性与 65 页路径。书签样本生效；重复内容长样本返回空树，明确标 empty，不称为质量通过。
这是研究脚本，不进入生产 import；provider 的最小依赖/许可/更新、正式 generation 合同与真实质量集仍需实现。

## 2026-09-10 本地实现进展：显式增强与有界并行

产品已具备 raw/merge provider、不可变 generation、由 Pi ModelRuntime 执行的显式
summary/expand/full 作业，以及只读 `docatlas_enrichment`。Python 仍仅负责文档处理，
没有模型凭证或第二个 Agent Loop；增强结果是独立密封的导航 overlay，不是 Evidence，
也不改写 canonical tree、历史 generation 或原始 PDF 的引用身份。

[ADR-053](../docs/adr/053-bounded-parallel-flash-enrichment.md) 的 v2 调度已实现。
请求不带 recipe 时仍使用原串行 v1，旧作业和原 key 恢复语义不变；新 Web 请求显式选择
`docatlas-flash-enrichment.v2`，同 key 改 recipe 会冲突。展开采用稳定 frontier，
摘要遵循先子后父依赖，每批最多两次独立调用，整批真实完成后才按原文顺序提交并继续。
同一个全作业预算池先预留调用、输入和最坏在途输出，输出额度等分向下取整；不足以容纳
两次时退回单次，短摘录也计入输出预算。宿主共享 provider 上限不变，Core 不猜测剩余槽位。

本轮定向验证：

- 源码测试 **20/20**，宿主/runtime 测试 **13/13**，两组定向 lint 通过；精确命令见 ADR-053。
- 受控 provider promise 观察到 v2 峰值并发 **2**、串行 v1 **1**；逆序返回不改变结果 hash，
  多层摘要与串行脚本响应具有同等语义。这不是实际耗时加速比，也不是付费模型质量评测。
- 真实生成 PDF、不可变 ingest、隔离的文档 worker 和作业存储联合测试覆盖取消、失败和关闭：
  必须等所有实际 provider promise 与文档 namespace 都退出，才能释放所有权/作业容量，
  不发布部分 overlay，也不在终态重放时重跑模型。
- 未更新 source pin、生成 vendor 或上游版本，未调用付费模型；最终全仓检查和最终浏览器
  路径验证由集成任务负责，在本次文档更新时仍待完成。

权利清晰的真实文档语料、OCR/多栏/图表、full 模型质量/成本、默认 provider 决策与非正常
停止后的恢复仍是独立 R5/R7 gate；不能用并发测试或早期四份 raw smoke 的时间替代。
