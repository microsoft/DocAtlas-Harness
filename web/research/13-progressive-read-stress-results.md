# Progressive Read 全面压力测试报告

> 日期：2026-08-30  
> 结论：本地机制、兼容性和边界压力全部通过；尚未达到生产就绪，暴露出索引重建延迟和 exhaustive
> tool-call amplification 两个明确瓶颈。  
> 完整 JSON：[progressive-read-stress-20260830-v3.json](../artifacts/progressive-read-stress-20260830-v3.json)  
> 可重复测试器：[`DocAtlas-Harness/scripts/stress_progressive_read.py`](../DocAtlas-Harness/scripts/stress_progressive_read.py)

## 1. 测试边界

本报告中的“全面”指本地 Read/dispatcher/source-processing 边界，不包括未经授权的 Azure 并发负载，也不
等于已经完成真实 QA gold-set 或 DSH plugin E2E。云端高并发会产生费用并影响共享限流，需要单独授权和
预算。

覆盖：

| 维度 | 强度 |
|---|---:|
| 合成文档 | 50 页、每页 120 段、共 6,052 blocks |
| 极限页面 | 5 页 × 约 4.5 MiB Markdown，共 22.5 MB |
| Read CLI 调用 | 435 次 |
| 顺序覆盖 | 122 次 cursor 调用，覆盖全部 6,052 blocks |
| 并发 | 24 workers、240 次 locate |
| 随机输入 | 2,000 个 Unicode/控制字符 query |
| Visual | 30 次目标 figure 请求 |
| 非法输入 | 8 类 mode/id/cursor/budget/page 错误 |
| 真实 PDF | 8 份，4–758 页，英文、中文、普通文本和扫描件 |
| Python matrix | 3.10、3.11、3.12.12、3.13 |

机器有 96 CPU、约 612 GiB 可用内存；测试只生成小型临时 corpus，并在结束时自动删除，避免在只剩约
89 GiB 的根盘上制造大型缓存。

## 2. 总体结果

```text
status                 passed
wall time              164.81 s
Read CLI calls         435
synthetic blocks       6,052
concurrent failures    0 / 240
fuzz failures          0 / 2,000
sequential duplicates  0
real PDF probes        8 / 8 completed
```

进程观测到的峰值：主压力进程约 180 MiB RSS，单个 child 峰值约 154 MiB。该数字是当前 Python/CLI
process 模型下的运行观测，不等同于未来长驻 sidecar 的稳定内存基线。

## 3. Tool result 缩减

### 3.1 50 页、6,052-block corpus

| 路径 | 模型可见字符数 |
|---|---:|
| legacy full-page Read | 644,853 |
| locate | 1,036 |
| locate / legacy | 0.161% |

即约减少 **99.839%**。Locate 仍然正确找到英文、中文、精确数字、重复 evidence、figure caption 和
untrusted document text 的目标页。

### 3.2 五个接近安全上限的 Markdown 页面

| 路径 | 模型可见字符数 | CLI latency |
|---|---:|---:|
| legacy | 22,500,427 | 0.61 s |
| locate | 568 | 5.11 s |
| locate / legacy | 0.00252% | — |

即约减少 **99.9975%**。但 locate 延迟约为 legacy 本地读取的 8.4 倍，因为当前 spike 每次调用都会重新
读取、切块、计算 hash、归一化并排序 22.5 MB 内容。Legacy 看似更快，只是把昂贵代价转嫁给网络、模型
context 和推理；它的 22.5M 字符结果在真实模型链路中通常不可接受。

此结果直接支持生产实现预建并持久化：

```text
SourceRepresentation
  → Block Map + content hashes
  → SQLite FTS5/index
  → query-time scope/filter/rank
```

不能在每次 `locate` 时从 Markdown 全量重建 blocks。

## 4. 正确性和完整性

通过的 invariants：

- 6,052 个 block IDs 全部唯一；相同 representation 重建后完全一致；
- blocks 只解析当前 `doc_id + requested pages` 内的 ID；
- expand 只有一个 `is_target=true`，邻居保持页面内 source order；
- sequential 的 cursor 单调前进，6,052 个 ID 与直接构建的顺序完全一致；
- 122 次 sequential 调用没有重复或遗漏；
- 单次 sequential 返回文本不超过配置预算；
- locate 空结果明确声明不能证明 absence；
- visual 的模型文本没有重复 page Markdown；
- malformed JSON、错误 ID、负 cursor、越界预算和 51-page 请求均返回结构化错误；
- document 中的 prompt-like 文本只被当作候选数据，没有执行路径。

### 新暴露的 tool-call amplification

6,052 blocks 在 `max_items=50` 下需要 122 次 sequential 调用。完整性是正确的，但超出了当前 Agent Loop
常见的 20-turn budget。生产版需要组合：

- 依据结构和字符预算自适应合并相邻短 blocks；
- sequential 返回 packed spans，而不是每个短段都独占 item；
- UI/Host 可流式遍历，但模型只接收当前 coverage window；
- list/absence 工作提供 deterministic coverage state，而不是要求模型记住 122 个 cursor。

在解决前，不能把“sequential 无遗漏”误写成“极端 exhaustive task 已可用”。

## 5. 延迟与并发

50 页、约 645 KiB corpus：

| 操作 | p50 | p95 / max |
|---|---:|---:|
| locate（串行六类 query） | 0.301 s | 0.872 s p95 |
| sequential CLI | 0.288 s | 0.332 s p95 |
| 24-worker locate | 0.318 s | 0.353 s p95 / 0.511 s max |
| visual figure | 0.231 s | 0.288 s p95 |

24 路、240 次并发 locate 全部返回预期目标，没有崩溃、超时、ID 漂移或结果污染。Block Map 直接构建
用时约 0.204 秒，`tracemalloc` 峰值约 4.47 MB。

2,000 个随机 query 对 6,052 blocks 的当前 in-memory rank 总计 97.38 秒，约 49 ms/query。该阶段进一步
说明 query-time 重复 normalization 不应进入生产热路径；normalized fields 和 FTS 应在 ingest 时生成。

## 6. Python 兼容矩阵

每个版本均使用独立、locked uv 环境运行完整 suite：

| Python | 结果 |
|---|---:|
| 3.10 | 180 passed |
| 3.11 | 180 passed |
| 3.12.12 | 180 passed |
| 3.13 | 180 passed |

合计 720 项回归通过。额外的 Ruff、format、mypy 和 `git diff --check` 通过；外层 DocAtlas-dsh 的
JavaScript、plugin build/manifest/compatibility、cross-language protocol 和 Python sidecar 检查也全部通过。

## 7. TUI 对齐

压力测试 v3 在 Read result header 中加入稳定的 `returned_candidates`、`returned_blocks` 和
`returned_block_chars`；TUI 使用这些字段显示：

```text
Read · locate · p.47-51 · 4/8 candidates · next=4
Read · blocks · p.47-51 · 2 blocks · 4,286 chars
Read · expand · p.47-51 · 3 blocks · 3,112 chars
Read · sequential · p.1-50 · 100/6052 blocks · next=100 · incomplete
Read · visual · p.49 · 1 figure · Markdown omitted
```

Locate 成功后最多显示三条经过 ANSI/control-character 清洗和终端宽度截断的预览。TTY、redirected output
和窄终端均有测试；没有增加 interactive block picker，也不会把完整 block result 重新输出到终端。

Composer 中输入 `@` 打开的文件 picker 另有明确的编辑语义：Backspace/Delete 删除临时触发符并返回
原输入行，Esc 关闭 picker 但把 `@` 保留为普通文本。独立 picker 仍用 Backspace 返回父目录，左方向键
在两种入口中均可返回父目录。回归同时覆盖 picker 状态、Backspace/Delete 的真实 PTY escape sequence，
以及已经插入的 `@path` 仍可由普通行编辑器删除。

## 8. 真实 PDF 探针

探针覆盖 PageIndex 测试文档、PRML（758 页）、年报、earnings、中文报告和扫描日报。每份文档抽取首/
中/末页做 sequential 和 locate，并以 zoom 0.5 渲染第一页 visual。

结果：

- 8/8 文件完成，无 crash/timeout；
- 8/8 visual 返回一张页面图，且没有重复文本；
- 普通 PDF 的三页 progressive output 保持在约 1.6–14.5 KB；
- visual 输出约 16.7–272.4 KB；
- 两份中文/扫描报告的 PyPDF text 完全为空，locate 正确返回空、visual 正常；
- `4000045.pdf` 的三张抽样页只产生 36 个字符但 `text_is_empty=false`，显示 binary empty flag 不足以表达
  “文本层极稀疏/疑似不可用”。

后一点需要新增 `text_quality`，例如 `empty / sparse / garbled / usable`，按字符密度、可打印比例、重复率
和 OCR/layout capability 决定是否建议 visual/OCR。不能只有一个 `text_is_empty`。

某份 222 页年报的首/中/末三页对 `revenue` 返回零 candidate；这不是证明检索失败或文档不存在该词，
而是再次验证 page scope 和 empty-result semantics：Locate 只能回答“当前 scope 未命中”。真实 retrieval
质量必须使用 gold page/block 数据集评估。

## 9. 尚未覆盖

- Azure Luna/其他模型的高并发负载、费用、rate limit 和 server-side chain；
- DSH plugin `docatlas_read` transport E2E，因为 progressive mode 尚未迁入 sidecar wire contract；
- 真实 gold evidence 的 block recall@5/@10 和最终 QA/citation 指标；
- 20-figure 单调用、zoom=4 大图和 GPU/OCR provider 的资源上限；
- `revisionId/representationId/TextQuote/bbox` 正式 Locator；
- Locator 到 EvidenceAtom 的 Core re-resolution 与 quote rejection；
- 长驻 sidecar 的并发、cancellation、restart 和 SQLite migration。

因此当前结果允许说“本地 progressive mechanism 经高强度验证”，不能说“端到端产品已完成全方位验证”。

## 10. 下一步门槛

按优先级：

1. ingest 时持久化 Block Map、normalized text 和 FTS5，消除 22.5 MB query-time rebuild；
2. sequential 自适应 pack，相同字符预算下降低 tool-call 数；
3. 引入 `text_quality` 和 OCR/visual routing；
4. 建立 10–20 份真实文档的 gold blocks，测 recall@k、output tokens 和 citation precision；
5. 冻结 `DocumentLocatorV1`，让 blocks 返回 revision-bound locator；
6. 实现 `locator + exact quote → re-resolve → EvidenceAtom`；
7. 迁入 DSH sidecar 后做单用户真实 Agent A/B；
8. 获得明确成本/限流授权后，才运行 Azure 并发压力测试。
