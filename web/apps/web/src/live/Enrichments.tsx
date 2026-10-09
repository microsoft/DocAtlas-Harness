import { useEffect, useRef, useState } from 'react'
import type { EnrichmentStart, EnrichmentJob, EnrichmentTree, LibraryDocumentSummary, TreeNode } from '@docatlas/contracts'
import { parseBrowserContract } from '@docatlas/contracts/browser'
import { Drawer } from '../Drawer'
import type { LiveClient, LiveState } from './client'

const stages = { queued: '已排队 · 尚未开始', preparing: '准备原文与基础树', generating: '正在增强（断线/重启后请核对执行归属）', completed: '增强已保存 · 仅作导航', failed: '增强失败，原文和基础树不变', cancelled: '已确认取消' }
export function LiveEnrichments({ client, state, document, onClose }: { client: LiveClient, state: LiveState, document: LibraryDocumentSummary, onClose(): void }) {
  const [base, setBase] = useState<EnrichmentTree | null>(null), [nodes, setNodes] = useState<TreeNode[]>([]), [selected, setSelected] = useState<string[]>([]), [mode, setMode] = useState<EnrichmentStart['mode']>('full')
  const [job, setJob] = useState<EnrichmentJob | null>(null), [pending, setPending] = useState<EnrichmentStart | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const alive = useRef(true), conversationId = state.selected!
  const key = `docatlas.live.draft.v1:${encodeURIComponent(state.actor!.actorId)}:${encodeURIComponent(state.actor!.workspaceId)}:@enrichment:${encodeURIComponent(conversationId)}:${encodeURIComponent(document.documentId)}`
  const lastId = useRef<string | null>(null)
  function save(request: EnrichmentStart, id: string | null) { sessionStorage.setItem(key, JSON.stringify({ request, id })); lastId.current = id; setPending(request) }
  useEffect(() => {
    alive.current = true
    try {
      const raw = sessionStorage.getItem(key)
      if (raw) { if (raw.length > 16384) throw new Error(); const value = JSON.parse(raw) as { request: unknown, id: unknown }, request = parseBrowserContract('enrichment', value.request)
        if (request.kind !== 'enrichment-start' || request.documentId !== document.documentId || request.revisionId !== document.currentRevisionId || value.id !== null && (typeof value.id !== 'string' || !/^[A-Za-z0-9._:~-]{1,128}$/.test(value.id))) throw new Error()
        setPending(request); lastId.current = value.id as string | null
      }
    } catch { setMessage('旧增强记录无法校验；未自动重启作业。') }
    return () => { alive.current = false }
  }, [key, document.documentId, document.currentRevisionId])
  async function load(offset = 0) {
    setBusy(true); setMessage('正在读取不可变的 Flash merge 基础树…')
    try {
      const value = await client.enrichmentRequest(conversationId, `documents/${encodeURIComponent(document.documentId)}/${encodeURIComponent(document.currentRevisionId)}/tree`, { mode: 'merge', offset })
      if (!alive.current) return
      if (value.kind !== 'enrichment-tree' || value.generation.documentId !== document.documentId || value.generation.revisionId !== document.currentRevisionId || value.tree.offset !== offset || offset && base?.generation.generationId !== value.generation.generationId) throw new Error()
      setBase(value); setNodes(items => offset ? [...items, ...value.tree.nodes] : value.tree.nodes); if (!offset) setSelected(value.tree.nodes[0] ? [value.tree.nodes[0].nodeId] : [])
      setMessage(value.tree.total === 0
        ? '未识别到可增强的目录节点，本次不会调用模型。可以继续阅读原文和检索；基础树为空不表示 PDF 没有正文。'
        : '选择需要增强的节点；选择父节点会包含其子树。')
    } catch { if (alive.current) setMessage('基础树暂不可用；可以继续阅读原文和检索。') }
    finally { if (alive.current) setBusy(false) }
  }
  async function inspect(id: string): Promise<EnrichmentJob> {
    const value = await client.enrichmentRequest(conversationId, `enrichments/${encodeURIComponent(id)}`)
    if (value.kind !== 'enrichment-job' || value.request.documentId !== document.documentId || value.request.revisionId !== document.currentRevisionId) throw new Error()
    if (alive.current) setJob(value)
    return value
  }
  async function run() {
    setBusy(true); setMessage('正在核对作业回执…')
    try {
      const request = pending ?? { schemaVersion: 1, kind: 'enrichment-start', documentId: document.documentId, revisionId: document.currentRevisionId, idempotencyKey: `enrich:${crypto.randomUUID()}`, baseMode: 'merge', nodeIds: selected, mode, recipe: 'docatlas-flash-enrichment.v2',
        budget: { maxNodes: 32, maxPages: 24, maxModelCalls: 16, maxInputChars: 120000, maxOutputTokens: 16384, maxOutputChars: 50000, wallMs: 180000 } } satisfies EnrichmentStart
      parseBrowserContract('enrichment', request); save(request, lastId.current)
      const accepted = await client.enrichmentRequest(conversationId, 'enrichments', request)
      if (!alive.current) return
      if (accepted.kind !== 'enrichment-job' || accepted.request.idempotencyKey !== request.idempotencyKey) throw new Error()
      save(request, accepted.jobId); setJob(accepted)
      if (accepted.state === 'queued') await client.enrichmentRequest(conversationId, `enrichments/${encodeURIComponent(accepted.jobId)}/run`, {})
      const deadline = Date.now() + request.budget.wallMs + 5000
      while (alive.current) {
        const current = await inspect(accepted.jobId)
        if (['completed', 'failed', 'cancelled'].includes(current.state)) { setMessage(stages[current.state]); return }
        if (Date.now() > deadline) { setMessage('尚无终态回执。可以查询状态；旧进程归属不会按超时被强制接管。'); return }
        await new Promise(resolve => setTimeout(resolve, 800))
      }
    } catch { if (alive.current) setMessage('增强结果未确认，保留原键；再次点击只核对同一作业。') }
    finally { if (alive.current) setBusy(false) }
  }
  return <Drawer title="Flash 增强" subtitle={`${document.displayName} · 摘要和展开仅用于导航，不是证据。`} onClose={onClose}>
    <p>使用服务配置的 Pi 模型。最多 24 页、32 节点、16 次调用、16,384 输出 token、3 分钟；超额不会发布半份结果。失败或取消不改变原件。</p>
    <p>新作业使用 v2 有界并行：最多同时处理两个独立节点，共享整项预算；旧待办保留原算法版本，不会自动升级。</p>
    <button className="secondary-button" disabled={busy || !!pending} onClick={() => void load()}>读取基础树</button>
    <label className="live-mode">增强方式<select aria-label="Flash 增强方式" value={mode} disabled={busy || !!pending} onChange={event => setMode(event.target.value as EnrichmentStart['mode'])}><option value="full">展开后生成摘要</option><option value="summary">仅摘要</option><option value="expand">仅展开</option></select></label>
    <div className="live-tree-targets">{nodes.map(node => <label key={node.nodeId}><input type="checkbox" aria-label={`增强：${node.title}`} checked={selected.includes(node.nodeId)} disabled={busy || !!pending} onChange={event => setSelected(items => event.target.checked ? [...items, node.nodeId] : items.filter(id => id !== node.nodeId))} /><span>{node.title} <small>第 {node.startPage}–{node.endPage} 页</small></span></label>)}</div>
    {base?.tree.nextOffset != null && <button disabled={busy || !!pending} onClick={() => void load(base.tree.nextOffset!)}>更多树节点</button>}
    <button className="primary-button" disabled={busy || !pending && !selected.length} onClick={() => void run()}>{busy ? '等待增强回执…' : pending ? '核对并继续同一作业' : '开始增强'}</button>
    {pending && <div className="live-outbox"><button onClick={() => { if (lastId.current) void inspect(lastId.current).catch(() => setMessage('无法查询旧作业')) }}>查询状态</button><button onClick={() => { if (lastId.current) void client.enrichmentRequest(conversationId, `enrichments/${encodeURIComponent(lastId.current)}/cancel`, {}).then(value => { if (alive.current && value.kind === 'enrichment-job') { setJob(value); setMessage(stages[value.state]) } }).catch(() => setMessage('取消尚未确认；旧归属需要核验。')) }}>取消增强</button><button disabled={busy} onClick={() => { sessionStorage.removeItem(key); setPending(null); setJob(null); lastId.current = null; setMessage('仅忘记本地作业记录，没有删除或停止服务端作业。') }}>忘记本地记录</button></div>}
    {message && <p role="status">{message}</p>}
    {job && <p data-enrichment-state={job.state}>{stages[job.state]}{job.error ? ` · ${job.error}` : ''}</p>}
    {job?.result && <section className="live-enrichment-result" aria-label="增强导航结果"><p>基础树保持不变 · {job.result.recipe} · {job.result.usage.calls} 次模型调用 · {job.result.usage.outputTokens} 输出 token</p>
      {job.result.nodes.map(node => <article key={node.nodeId}><h3>{node.title}</h3><small>第 {node.startPage}–{node.endPage} 页 · {node.summaryKind === 'source-excerpt' ? '短节点原文摘录' : '生成式导航'}</small>{node.summary && <p>{node.summary}</p>}</article>)}
    </section>}
  </Drawer>
}
