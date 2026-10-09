# PageIndex SDK、MCP、Flash 与 ChatIndex 研究

> 2026-09-08 更新入口：[Flash 采用与 SDK 复核](18-pageindex-flash-adoption.md)。本页保留原固定源码研究；
> 文中 DSH ownership 已由 ADR-021 的 DocAtlas Core + Pi runtime 目标替代，provider/证据边界仍保留。
> 2026-09-09 更正：Python稳定版0.2.15已在当前pin内，源码0.2.10是发布占位值；JS main与npm0.8.0并非同一API快照。Cloud doc_id / JS folderScope不是统一硬ACL，见[复核38](38-pageindex-sdk-followup.md)。

> 研究日期：2026-08-29  
> Python SDK：[`PageIndex@9fee239`](https://github.com/VectifyAI/PageIndex/tree/9fee239b174fcc205fec28df105e519ac7171522) (`0.2.10`)  
> 后续更新：本地 source 已升级到 ae16956；本文保留初次版本依据，最新差异/采用状态见 [Flash 更新记录](18-pageindex-flash-adoption.md)。
> JavaScript SDK：[`9925e8a`](https://github.com/VectifyAI/pageindex-js-sdk/tree/9925e8a347a9985424f4bb4e95718a75814b9b67) (`0.8.0`)  
> MCP wrapper：[`bda946b`](https://github.com/VectifyAI/pageindex-mcp/tree/bda946b4b6fffaaf6926aa8809bc62e0098f30e8) (`1.8.2`)  
> ChatIndex：[`7df2c92`](https://github.com/VectifyAI/ChatIndex/tree/7df2c9208db6f113f85a6c09295bec7f0f2114e7)

## 结论先行

PageIndex 最值得 DocAtlas 借鉴的不是“再接一个 Chat API”，而是四个清晰边界：

1. index 与 chat 是两个独立 provider side；
2. tree structure 与原始 page content 是两种读取；
3. read-only agent tools 与 destructive management tools 默认分开；
4. 大结果必须分页、限额并返回下一步提示。

在 DocAtlas-dsh 中，DSH 已经拥有 chat/Agent Loop，因此 PageIndex 应只作为可替换的
`DocumentIndexProvider`/`DocumentContentProvider`，不让 `client.chat()` 再包一层 Agent。

其 reasoning-based tree 思路的公开说明见
[PageIndex introduction](https://pageindex.ai/blog/pageindex-intro)；本文的能力判断仍以固定 SDK 源码为准。

## 1. Python SDK 的两侧模型

`PageIndexClient` 把配置拆成两个正交问题：

- **index**：文档在哪里解析、建树和保存；local 或 PageIndex Cloud。
- **chat**：谁搜索 tree 并回答；用户自己的模型或 PageIndex managed chat。

有效组合：

| Index | Chat | 支持 | DocAtlas 含义 |
|---|---|---:|---|
| local | own model | 是 | 全本地文档；但不要使用 SDK chat，由 DSH tools 接管。 |
| cloud | own model | 是 | 文档在 PageIndex Cloud，DSH 模型读取 cloud tool/page。 |
| cloud | managed | 是 | PageIndex 完整产品路径；与 DSH Loop 重叠，不是首选。 |
| local | managed | 否 | managed chat 无法访问本地磁盘。 |

这个拆分应推广成 DocAtlas provider interface，而不是在业务代码里判断“当前是不是 PageIndex”。

## 2. Local mode 能做什么、不能做什么

根据固定源码与[官方 Python SDK 文档](https://docs.pageindex.ai/sdk)：

| 能力 | Local | Cloud |
|---|---:|---:|
| PDF 建树与本地存储 | 是 | 是，异步 managed pipeline |
| tree structure | 是 | 是 |
| page text | 是 | 是 |
| 多文档 doc-id scope | 手动列表 | 是 |
| folders / corpus hierarchy | 否 | 是 |
| OCR / image understanding | 否 | 是 |
| line-level citation | 否，page-level | 是 |
| document images / embedded image tool | 否 | 是 |
| relevance document ranking | 否 | Cloud tool 支持 |
| MCP server | 否 | 是 |

Local mode 的 `pages.json` 本质是每页 `{page_index, markdown}`，对扫描 PDF 没有本地 OCR；不要把
Cloud 页图、folder、image annotation 能力写进统一最低契约。

## 3. PageIndex Flash

`page_index_flash()` 使用 PDF layout statistics 生成 tree structure，结构提取本身不需要 LLM。

- `summary=False, optimize=False`：完全无 LLM 的 raw tree。
- `optimize="merge"`：确定性 merge，不做 LLM expand。
- 默认：LLM expand + summaries；模型不可达会按当前实现的错误策略失败。
- bookmark-only 或 scanned PDF 没有可读 page text 时，expand 无法进行。

这给 DocAtlas 一个很好的降级阶梯：

```text
raw layout tree
  → deterministic cleanup
  → optional summaries
  → optional retrieval optimization
```

UI 应显示 tree 的来源和质量状态，例如 `layout-only`、`summarized`、`optimized`，不能把 raw heading
和模型 summary 混成同一种“文档事实”。

## 4. Agent tool contract 的好设计

Python SDK 为自有 Agent 暴露的共同最低工具是：

```text
browse_documents
get_document
get_document_structure
get_page_content
```

`remove_document` 只有 `include_management=True` 才加入。值得复用的细节：

- Python local tools 的 `doc_ids` 是硬 allowlist；cloud own-model路径只做prompt targeting，cloud `agent_tools(doc_id=...)`直接拒绝，不能泛化为统一权限边界；
- 工具错误不抛裸 exception，而返回 `{error, errorCode?, details?, next_steps}`；
- structure 自动拆成 `part/total_parts`，不是任意截断；
- page content 有约 100k character 的总响应上限，并明确返回哪些页；
- 页范围语法严格解析、排序、去重、检查越界；
- 对大于 20 页的文档，引导先看 structure 再读取 targeted pages；
- 文档名冲突要求携带 folder id，而不是猜一个。

DocAtlas 工具不必复刻这些名字，但应复刻行为：read tools 默认、management tools 显式开启、作用域
是执行期硬门、错误告诉 Agent 下一步、每个结果带完整的 truncation/pagination 元数据。

## 5. JavaScript SDK 的真实定位

`@pageindex/sdk@0.8.0` 很适合 DSH 的 Node Host 直接访问 PageIndex Cloud：

- `client.api`：REST upload/tree/document/list/delete/folder/chat；
- `client.tools`：typed MCP wrappers；
- MCP 使用 Streamable HTTP，空闲默认 60 秒断开；
- `folderScope`并不统一限制所有REST操作：MCP传scope header，REST默认folder仅用于submit/list，get/tree/delete不带它；运行时setter又只改MCP，产品必须单独逐操作授权；
- chat 支持 streaming、multi-document 与 citation metadata。

但它要求 `apiKey`，没有 Python SDK 的 local indexing 实现。它是 Cloud client，不是本地 PageIndex
的 TypeScript 替代品。DocAtlas 如果需要本地 tree，仍应通过 Python sidecar 或自己的索引 provider。

## 6. MCP wrapper 的适用范围

`@pageindex/mcp` 主要把本地 PDF upload 转发到 PageIndex 的 remote MCP/server，并代理 remote tools
和 resources。它适合通用 MCP client 接入，不负责：

- 文档原文阅读 UI；
- DSH session projection；
- DocAtlas finding/evidence 状态；
- 个性化记忆；
- 本地 PageIndex Flash 的完整 provider。

DSH 已有 MCP client，做验证时可以零代码接 PageIndex MCP；产品版仍应注册 DocAtlas 自有工具，保证
统一 locator、权限、UI meta 和 provider 可替换性。

## 7. Citation 需要超过 page-level tag

PageIndex 示例使用：

```xml
<cite doc="report.pdf" page="12"/>
```

这对回答可读性很好，但只能把用户带到一页。DocAtlas 的统一 locator 至少需要：

```ts
interface DocumentLocator {
  documentId: string        // authoritative opaque id, never only filename
  revisionId: string        // content hash or immutable provider revision
  page: number              // physical PDF page, 1-based
  quote?: { exact: string; prefix?: string; suffix?: string }
  bbox?: { x: number; y: number; width: number; height: number; unit: 'pdf-point' | 'ratio' }
  figureRef?: string
  blockId?: string
}
```

导航按能力降级：`bbox → exact quote → block → page`。回答中的可见 citation 可以仍然简洁，完整
locator 放 tool meta/evidence record。

## 8. File System blog：灵感与边界

[PageIndex File System](https://pageindex.ai/blog/pageindex-filesystem) 提出：

- 文档内部 tree 之上再放 corpus/file tree；
- flat corpus 可生成 semantic virtual nodes；
- 同一文档可以出现在多个虚拟祖先下；
- hierarchy 可以 query-conditioned；
- 对没有信息量的中间目录动态 flatten。

它启发 DocAtlas 做 **Lens**，而不是篡改 canonical tree：风险、时间线、实体、用户关注点分别是
同一文档集的派生视图。用户记忆可以影响 Lens 排序，但每个节点始终能回到 canonical document
locator。

重要边界：该 File System 是 2026-05 博文描述的 Enterprise 能力，不在本次固定的开源 local SDK
契约内；不能据此承诺本地百万文档、query-time virtual tree 或“越用越准”。

## 9. ChatIndex 对长期记忆的启发

ChatIndex 把 raw conversation 放在 leaf，internal node 放 topic summary；检索可以在足够的 summary
层停止，也可以一路下钻到原始消息。这个 **lossless fallback + multi-resolution retrieval** 很适合
DocAtlas：

- 长期记忆是派生索引，不替代 DSH raw Session log；
- 高层用户画像必须能展开到 observation，再展开到 session/message；
- 简单偏好只读 summary，冲突或高风险决定必须回源。

但其 README 同时把 incremental updates 列在未完成 roadmap。当前代码是研究原型，不能作为生产
增量 memory engine 直接嵌入。

## 10. 推荐 Provider 契约

```ts
interface DocumentProvider {
  capabilities(): ProviderCapabilities
  ingest(input: DocumentInput, signal: AbortSignal): Promise<DocumentRevision>
  list(scope: DocumentScope, cursor?: string): Promise<DocumentPage>
  structure(documentId: string, cursor?: string): Promise<StructurePage>
  pages(documentId: string, pages: number[], budget: ReadBudget): Promise<PageBatch>
  asset(locator: AssetLocator, signal: AbortSignal): Promise<ReadableStream>
}
```

实现候选：

- `docatlas-local`：现有 PDF/Markdown/figure + PageIndex/Flash tree；
- `pageindex-cloud`：JS SDK REST/MCP，capability 包含 OCR/images/folders；
- `filesystem-basic`：无 tree 时页级浏览与全文查找的保底 provider。

Agent 工具只依赖这个契约，并把 capability-aware 错误返回模型；UI 可以显示 provider badge，但不在
组件中分叉业务规则。

## 11. 对 DocAtlas 的直接决策

| 问题 | 决策 |
|---|---|
| 是否采用 PageIndex chat | 否，DSH Agent Loop 已负责。 |
| 是否复用 PageIndex tree | 是，作为一个 index provider。 |
| JS SDK 是否替代 Python local | 否，它是 Cloud client。 |
| 是否先做 MCP | 可作验证适配，不作为最终产品协议。 |
| citation 是否只存 doc/page | 否，必须有 revision + quote/bbox 等可选 locator。 |
| personalized tree 是否改 canonical tree | 否，做可解释 Lens overlay。 |
| ChatIndex 是否直接用 | 否，只借鉴 raw leaf + summary hierarchy。 |
