import { useEffect, useRef, useState } from 'react'
import type { EnrichmentJob, EnrichmentStart, TreeGeneration, TreeNode, TreeSummaryPreview } from '@docatlas/contracts'
import { parseBrowserContract } from '@docatlas/contracts/browser'
import type { PdfReaderSource } from '../PdfReader'
import { canonicalHash } from './state'
import { useUi } from './locale'
import { Icon } from '../icons'
import { WorkingIndicator } from './WorkingIndicator'

export interface MapSummaryAccess { ownerKey: string, request(path: string, body?: unknown): Promise<EnrichmentJob> }
export interface SummaryOutbox { request: EnrichmentStart, generationId: string, treeHash: string, jobId: string | null }
export const MAP_SUMMARY_BUDGET = { maxNodes: 32, maxPages: 24, maxModelCalls: 16, maxInputChars: 120000, maxOutputTokens: 16384, maxOutputChars: 50000, wallMs: 180000 } as const
export function parseMapSummaryOutbox(raw: string, source: PdfReaderSource, generation: TreeGeneration, node: TreeNode): SummaryOutbox {
  if (raw.length > 16384) throw new Error('Summary task exceeds its local bound')
  const value = JSON.parse(raw) as SummaryOutbox
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'generationId,jobId,request,treeHash') throw new Error('Invalid summary task')
  const request = parseBrowserContract('enrichment', value.request)
  if (request.kind !== 'enrichment-start' || request.documentId !== source.serverRevision?.documentId || request.revisionId !== source.serverRevision?.revisionId
    || request.baseMode !== 'merge' || request.mode !== 'summary' || request.recipe !== 'docatlas-flash-enrichment.v2' || request.nodeIds.length !== 1 || request.nodeIds[0] !== node.nodeId
    || Object.entries(MAP_SUMMARY_BUDGET).some(([name, limit]) => Reflect.get(request.budget, name) !== limit)
    || value.generationId !== generation.generationId || value.treeHash !== generation.treeHash || value.jobId !== null && (typeof value.jobId !== 'string' || !/^[A-Za-z0-9._:~-]{1,256}$/u.test(value.jobId))) throw new Error('Summary task source or budget changed')
  return value
}
export function checkedNodeSummary(source: PdfReaderSource, generation: TreeGeneration, node: TreeNode, job: EnrichmentJob, preview?: TreeSummaryPreview): string {
  const result = job.result, item = result?.nodes.find(item => item.nodeId === node.nodeId)
  if (job.state !== 'completed' || !result || !item?.summary || result.sourceHash !== source.sha256 || result.documentId !== source.serverRevision?.documentId
    || result.revisionId !== source.serverRevision?.revisionId || result.baseGenerationId !== generation.generationId || result.baseTreeHash !== generation.treeHash
    || item.title !== node.title || item.parentId !== node.parentId || item.startPage !== node.startPage || item.endPage !== node.endPage
    || preview && (preview.jobId !== job.jobId || preview.resultHash !== result.resultHash || preview.summaryKind !== item.summaryKind
      || preview.preview !== [...item.summary].slice(0, 240).join('') || preview.truncated !== ([...item.summary].length > 240))) throw new Error('Summary source changed')
  return item.summary
}
export async function verifiedNodeSummary(source: PdfReaderSource, generation: TreeGeneration, node: TreeNode, job: EnrichmentJob, preview?: TreeSummaryPreview): Promise<string> {
  const text = checkedNodeSummary(source, generation, node, job, preview), { resultHash, ...unsigned } = job.result!
  if (await canonicalHash(unsigned) !== resultHash) throw new Error('Summary result seal changed')
  return text
}

/** Optional navigation summaries reuse the existing explicit, idempotent Flash job protocol. */
export function MapNodeSummary({ source, generation, node, preview, access, onUpdated }: {
  source: PdfReaderSource, generation: TreeGeneration, node: TreeNode, preview: TreeSummaryPreview | undefined, access: MapSummaryAccess | undefined, onUpdated(): void,
}) {
  const { t } = useUi(), alive = useRef(true), flight = useRef(false)
  const [text, setText] = useState(preview && !preview.truncated ? preview.preview : ''), [kind, setKind] = useState(preview?.summaryKind)
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [confirm, setConfirm] = useState(false), [error, setError] = useState(false)
  const [outbox, setOutbox] = useState<SummaryOutbox | null>(null), [invalid, setInvalid] = useState(false), [job, setJob] = useState<EnrichmentJob | null>(null)
  const [retry, setRetry] = useState(0)
  const key = access ? `${access.ownerKey}:${encodeURIComponent(source.id)}:${encodeURIComponent(generation.generationId)}:${encodeURIComponent(node.nodeId)}` : ''
  const exceedsPageBudget = node.endPage - node.startPage + 1 > MAP_SUMMARY_BUDGET.maxPages
  const currentOutbox = useRef(outbox); currentOutbox.current = outbox
  useEffect(() => {
    alive.current = true
    if (key) try {
      const raw = sessionStorage.getItem(key)
      if (raw) {
        const value = parseMapSummaryOutbox(raw, source, generation, node)
        setOutbox(value); currentOutbox.current = value
      }
    } catch { setInvalid(true) }
    if (preview?.truncated && access) {
      setLoading(true)
      void access.request(`enrichments/${encodeURIComponent(preview.jobId)}`).then(async value => {
        const summary = await verifiedNodeSummary(source, generation, node, value, preview)
        if (alive.current) { setText(summary); setKind(preview.summaryKind) }
      }).catch(() => { if (alive.current) { setText(''); setError(true) } }).finally(() => { if (alive.current) setLoading(false) })
    }
    return () => { alive.current = false }
  }, [retry])
  function save(value: SummaryOutbox) { sessionStorage.setItem(key, JSON.stringify(value)); currentOutbox.current = value; setOutbox(value) }
  async function inspect(id: string) {
    const value = await access!.request(`enrichments/${encodeURIComponent(id)}`), pending = currentOutbox.current
    if (!pending || await canonicalHash(value.request) !== await canonicalHash(pending.request)) throw new Error('Summary job request changed')
    if (alive.current) setJob(value)
    if (value.state === 'completed') {
      const summary = await verifiedNodeSummary(source, generation, node, value)
      if (alive.current) {
        setText(summary); setKind(value.result!.nodes.find(item => item.nodeId === node.nodeId)!.summaryKind ?? undefined)
        sessionStorage.removeItem(key); currentOutbox.current = null; setOutbox(null); setConfirm(false); onUpdated()
      }
    }
    return value
  }
  async function generate() {
    if (!access || flight.current || invalid) return
    flight.current = true; setBusy(true); setError(false)
    try {
      const pending = currentOutbox.current ?? { generationId: generation.generationId, treeHash: generation.treeHash, jobId: null,
        request: { schemaVersion: 1, kind: 'enrichment-start', documentId: source.serverRevision!.documentId, revisionId: source.serverRevision!.revisionId,
          idempotencyKey: `summary:${crypto.randomUUID()}`, baseMode: 'merge', nodeIds: [node.nodeId], mode: 'summary', recipe: 'docatlas-flash-enrichment.v2',
          budget: { ...MAP_SUMMARY_BUDGET } } satisfies EnrichmentStart }
      save(pending)
      const accepted = await access.request('enrichments', pending.request)
      if (!alive.current) return
      if (await canonicalHash(accepted.request) !== await canonicalHash(pending.request)) throw new Error('Summary request changed')
      if (pending.jobId && pending.jobId !== accepted.jobId) throw new Error('Summary job identity changed')
      save({ ...pending, jobId: accepted.jobId }); setJob(accepted)
      if (accepted.state === 'queued') await access.request(`enrichments/${encodeURIComponent(accepted.jobId)}/run`, {})
      const until = Date.now() + pending.request.budget.wallMs + 5000
      while (alive.current) {
        const value = await inspect(accepted.jobId)
        if (['completed', 'cancelled', 'failed'].includes(value.state)) return
        if (Date.now() > until) throw new Error('Summary result is still unknown')
        await new Promise(resolve => setTimeout(resolve, 800))
      }
    } catch { if (alive.current) setError(true) }
    finally { flight.current = false; if (alive.current) setBusy(false) }
  }
  async function cancel() {
    const pending = currentOutbox.current, id = pending?.jobId
    if (!id || !pending || !access) return
    try {
      const value = await access.request(`enrichments/${encodeURIComponent(id)}`)
      if (value.jobId !== id || await canonicalHash(value.request) !== await canonicalHash(pending.request)) throw new Error('Cancellation does not match the original task')
      await access.request(`enrichments/${encodeURIComponent(id)}/cancel`, {}); if (alive.current) await inspect(id)
    }
    catch { if (alive.current) setError(true) }
  }
  return <section className="map-summary" aria-label={t('Section summary', '章节摘要')}>
    <h3><Icon name="note" size={14} />{t('Summary', '摘要')}{text && <small>{kind === 'source-excerpt' ? t('Source excerpt', '原文摘录') : t('Generated', '生成摘要')}</small>}</h3>
    {loading ? <WorkingIndicator small label={t('Loading summary', '读取摘要')} /> : text ? <p className="map-summary-text">{text}</p> : <p className="map-summary-empty">{error ? t('This summary could not be verified.', '暂时无法核对这份摘要。') : t('No summary has been generated for this section yet.', '这个章节还没有生成摘要。')}</p>}
    {error && preview && !outbox && <button className="map-secondary" onClick={() => { setError(false); setRetry(value => value + 1) }}>{t('Retry summary', '重试读取摘要')}</button>}
    {!!text && <p className="map-summary-note">{t('A reading guide, not verified evidence.', '用于辅助阅读，不是已核验证据。')}</p>}
    {!text && !preview && !outbox && !invalid && access && <><button className="map-summary-generate" disabled={loading || exceedsPageBudget} aria-expanded={confirm} onClick={() => setConfirm(value => !value)}><Icon name="plus" size={13} />{t('Generate summary', '生成章节摘要')}</button>{exceedsPageBudget && <p className="map-summary-note">{t('Choose a smaller section. This generation preset supports up to 24 pages.', '请选择更小的章节，当前生成配置最多支持24页。')}</p>}</>}
    {confirm && !outbox && <div className="map-summary-confirm"><p>{t('Summarize this section and its children using the configured model. Up to 24 pages, 32 nodes, 16 calls and 16,384 output tokens. The original stays unchanged.', '使用已配置模型概括本节及其子章节。最多24页、32节点、16次调用、16,384输出token；不修改原文。')}</p><button className="map-primary" onClick={() => void generate()}>{t('Confirm and generate', '确认生成')}</button><button className="map-secondary" onClick={() => setConfirm(false)}>{t('Cancel', '取消')}</button></div>}
    {busy && <div className="map-summary-progress" role="status"><WorkingIndicator small />{t('Preparing chapter summaries…', '正在生成章节摘要…')}</div>}
    {outbox && <div className="map-summary-job"><p>{job?.state === 'failed' ? t('Generation failed. The original is unchanged.', '摘要生成失败，原文未改变。') : job?.state === 'cancelled' ? t('Generation cancelled.', '生成已取消。') : t('This task is saved. Closing the map will not restart it.', '已保留本次任务，关闭地图不会重启任务。')}</p>
      {!busy && <button className="map-secondary" onClick={() => void generate()}>{t('Check and resume same task', '核对并继续原任务')}</button>}
      {outbox.jobId && !['completed', 'failed', 'cancelled'].includes(job?.state ?? '') && <button className="map-secondary" onClick={() => void cancel()}>{t('Cancel generation', '取消生成')}</button>}
      {!busy && <button className="map-summary-dismiss" onClick={() => { if (!['failed', 'cancelled', 'completed'].includes(job?.state ?? '') && !window.confirm(t('This will not stop a running task. Clearing the record may let you start a duplicate. Continue?', '清除记录不会停止服务端任务，也可能导致你另建重复任务。继续吗？'))) return; sessionStorage.removeItem(key); setOutbox(null); currentOutbox.current = null; setJob(null); setConfirm(false); setError(false) }}>{t('Clear local task record only', '仅清除本地任务记录')}</button>}
    </div>}
    {invalid && <p role="alert">{t('The saved task cannot be verified. It has not been restarted.', '旧任务记录无法核验，未重新启动。')}<button onClick={() => { sessionStorage.removeItem(key); setInvalid(false) }}>{t('Discard local record', '舍弃本地记录')}</button></p>}
    {error && outbox && <p className="map-summary-note" role="alert">{t('The result is unconfirmed. Retry checks the same task; it will not create a new one.', '结果尚未确认，重试核对同一任务，不创建新任务。')}</p>}
  </section>
}
