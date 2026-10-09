import { useEffect, useRef, useState } from 'react'
import type { LibraryDocumentSummary, ProductRevisionHistory, ProductRevisionImport, ProductRevisionImportState, UploadStart } from '@docatlas/contracts'
import { Drawer } from '../Drawer'
import type { PdfReaderSource } from '../PdfReader'
import type { LiveClient, LiveState } from './client'
import type { ReaderPane } from './reader-state'
import { acknowledgeVersion, advancePendingVersion, bindRevisionImport, mergeRevisionHistory, readVersionOutbox, revisionOriginalSource, revisionSourceChoice,
  savePendingVersion, uploadMatchesVersion, versionOwner, versionOwnerKey, versionStateMatches, type PendingVersion, type RevisionEntry, type VersionOutbox } from './version-state'
import './version-history.css'

interface RevisionClient extends Pick<LiveClient, 'state' | 'documentRequest' | 'uploadBytes' | 'setSources'> {
  revisionHistory(conversationId: string, documentId: string, cursor?: string): Promise<ProductRevisionHistory>
  revisionImport(conversationId: string, request: ProductRevisionImport): Promise<ProductRevisionImportState>
  revisionImportStatus(conversationId: string, request: ProductRevisionImport): Promise<ProductRevisionImportState>
}
interface ReadIntent { complete(source: PdfReaderSource): boolean, reject(): void }
const phases = { queued: '等待处理', hashing: '核对文件', ingesting: '解析与索引', committing: '提交不可变版本', complete: '处理结束' }

export function VersionHistory({ client, state, document, onReadStart, onClose, onImported }: { client: RevisionClient, state: LiveState, document: LibraryDocumentSummary,
  onReadStart(pane?: ReaderPane): ReadIntent, onClose(): void, onImported?(): void,
}) {
  const owner = versionOwner(state, document.documentId), stamp = owner ? versionOwnerKey(owner) : ''
  const [history, setHistory] = useState<ProductRevisionHistory | null>(null), [outbox, setOutbox] = useState<VersionOutbox>({ state: 'empty' })
  const [job, setJob] = useState<ProductRevisionImportState | null>(null), [notice, setNotice] = useState(''), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [storageBlocked, setStorageBlocked] = useState(false)
  const epoch = useRef(0), listSequence = useRef(0), statusSequence = useRef(0), busyRef = useRef(false), activeStamp = useRef(stamp)
  const fileInput = useRef<HTMLInputElement>(null), intents = useRef(new Set<() => void>())
  activeStamp.current = stamp
  const current = (token: number, expected = stamp) => { const now = versionOwner(client.state(), document.documentId); return token === epoch.current && expected === activeStamp.current && now !== null && versionOwnerKey(now) === expected }
  function restore(): VersionOutbox {
    if (!owner) return { state: 'empty' }
    try { const value = readVersionOutbox(sessionStorage, owner); setOutbox(value); setStorageBlocked(false); return value }
    catch { setStorageBlocked(true); setNotice('此标签页的版本待办无法读取，未发送任何导入。'); return { state: 'empty' } }
  }
  function retained(previous: PendingVersion, next: PendingVersion): PendingVersion { advancePendingVersion(sessionStorage, previous, next); restore(); return next }
  async function load(cursor?: string) {
    if (!owner) return
    const token = epoch.current, sequence = ++listSequence.current, previous = history
    setLoading(true)
    try {
      const value = await client.revisionHistory(owner.conversationId, owner.documentId, cursor)
      if (!current(token) || sequence !== listSequence.current) return
      setHistory(mergeRevisionHistory(owner, previous, value, cursor))
    } catch { if (current(token) && sequence === listSequence.current) setNotice('版本历史尚不可用或分页期间当前版本已变化。请刷新，不会用最新版本替代旧版本。') }
    finally { if (current(token) && sequence === listSequence.current) setLoading(false) }
  }
  async function acceptStatus(pending: PendingVersion, value: ProductRevisionImportState, token: number, sequence?: number): Promise<boolean> {
    const stillCurrent = () => current(token) && (sequence === undefined || sequence === statusSequence.current)
    if (!await versionStateMatches(pending, value)) throw new Error('Version state does not match the frozen request')
    if (!stillCurrent()) return true
    setJob(value)
    if (value.job?.status === 'succeeded') {
      if (!await acknowledgeVersion(sessionStorage, pending, value, stillCurrent)) { if (!stillCurrent()) return true; throw new Error('Version receipt could not acknowledge the original outbox') }
      if (!stillCurrent()) return true
      setOutbox({ state: 'empty' })
      setNotice(value.job.document!.currentRevision.revisionId === pending.expectedCurrentRevisionId
        ? '已确认复用当前版本的相同内容，没有新增版本，也未更改提问来源。' : '新版本已保存，旧版本仍保留。提问勾选未自动升级，请明确选择要使用的版本。')
      await load(); if (current(token)) onImported?.()
      return true
    }
    if (value.job?.status === 'failed' || value.job?.status === 'cancelled') {
      setNotice(`版本处理${value.job.status === 'failed' ? '失败' : '已取消'}${value.job.error ? `（${value.job.error.code}）` : ''}。原请求保留；不会自动重试或替换目标版本。`)
      return true
    }
    setNotice(value.job ? `${phases[value.job.phase]}；这不是成功回执，提问来源未变。` : '尚未找到已接受的版本导入。可以显式使用原键继续；不会自动重发或生成新键。')
    return false
  }
  async function readStatus(pending: PendingVersion) {
    if (!owner || versionOwnerKey(pending.owner) !== versionOwnerKey(owner)) return
    const token = epoch.current, sequence = ++statusSequence.current
    try {
      if (pending.request) {
        const value = await client.revisionImportStatus(owner.conversationId, pending.request)
        if (!current(token) || sequence !== statusSequence.current) return
        await acceptStatus(pending, value, token, sequence)
      } else if (pending.uploadReceipt) {
        const value = await client.documentRequest(owner.conversationId, `uploads/${encodeURIComponent(pending.uploadReceipt.uploadId)}`)
        if (!current(token) || sequence !== statusSequence.current) return
        if (value.kind !== 'upload' || !uploadMatchesVersion(pending, value)) throw new Error('Upload lookup changed')
        if (value.status !== pending.uploadReceipt.status) retained(pending, { ...pending, uploadReceipt: value })
        setNotice(value.status === 'stored' ? '原件已经保存，尚未提交此文档的版本导入。请使用原键继续。' : '原件尚未完整保存，请重新选择同一文件续传。')
      } else setNotice('上传预留回执尚未确认；刷新不会重新预留。可重新选择同一文件或显式使用原键继续。')
    } catch { if (current(token) && sequence === statusSequence.current) setNotice('未能核对原版本操作。原请求仍保留，没有自动续传或重发。') }
  }
  useEffect(() => {
    epoch.current++; listSequence.current++; statusSequence.current++; busyRef.current = false
    setHistory(null); setJob(null); setNotice(''); setLoading(false); setBusy(false); setOutbox({ state: 'empty' }); setStorageBlocked(false)
    const saved = restore()
    void load()
    if (saved.state === 'pending' && saved.current) void readStatus(saved.value)
    return () => { epoch.current++; statusSequence.current++; listSequence.current++; for (const reject of intents.current) reject(); intents.current.clear() }
  }, [stamp])

  async function process(pending: PendingVersion, token: number, file?: File) {
    if (!owner || !current(token) || versionOwnerKey(pending.owner) !== stamp) return
    let value = pending
    if (!value.request || value.uploadReceipt?.status !== 'stored') {
      let receipt = value.uploadReceipt
      if (!receipt) {
        const reserved = await client.documentRequest(owner.conversationId, 'uploads', value.upload)
        if (!current(token)) return
        if (reserved.kind !== 'upload' || !uploadMatchesVersion(value, reserved)) throw new Error('Upload reservation changed')
        receipt = reserved; value = retained(value, { ...value, uploadReceipt: receipt })
      }
      const stored = await client.documentRequest(owner.conversationId, `uploads/${encodeURIComponent(receipt.uploadId)}`)
      if (!current(token)) return
      if (stored.kind !== 'upload' || !uploadMatchesVersion(value, stored)) throw new Error('Upload lookup changed')
      if (stored.status !== value.uploadReceipt!.status) value = retained(value, { ...value, uploadReceipt: stored })
      if (stored.status !== 'stored') {
        if (!file) { setNotice('请重新选择与原待办名称、大小和哈希完全一致的 PDF 续传。'); return }
        const uploaded = await client.uploadBytes(owner.conversationId, stored.uploadId, file)
        if (!current(token)) return
        if (!uploadMatchesVersion(value, uploaded) || uploaded.status !== 'stored') throw new Error('Upload bytes were not confirmed')
        value = retained(value, { ...value, uploadReceipt: uploaded })
      }
      value = retained(value, bindRevisionImport(value))
    }
    let state = await client.revisionImportStatus(owner.conversationId, value.request!)
    if (!current(token)) return
    if (!await versionStateMatches(value, state)) throw new Error('Import status changed')
    if (!current(token)) return
    if (state.job === null) {
      state = await client.revisionImport(owner.conversationId, value.request!)
      if (!current(token)) return
    }
    const deadline = Date.now() + 120000
    while (current(token)) {
      if (await acceptStatus(value, state, token)) return
      if (Date.now() >= deadline) { setNotice('仍未获得终态回执。可以稍后只查询状态；原请求不会按超时换键。'); return }
      await new Promise(resolve => setTimeout(resolve, 750))
      if (!current(token)) return
      state = await client.revisionImportStatus(owner.conversationId, value.request!)
    }
  }
  async function start(file?: File) {
    if (!owner || busyRef.current || storageBlocked || outbox.state === 'invalid' || outbox.state === 'pending' && !outbox.current || !history) return
    const token = epoch.current, frozenOwner = { ...owner }, expectedCurrentRevisionId = history.currentRevisionId
    busyRef.current = true; setBusy(true); statusSequence.current++
    try {
      const retainedOutbox = readVersionOutbox(sessionStorage, frozenOwner)
      if (retainedOutbox.state === 'invalid' || retainedOutbox.state === 'pending' && !retainedOutbox.current) throw new Error('原版本待办无法在当前上下文校验')
      let saved = retainedOutbox.state === 'pending' ? retainedOutbox.value : undefined
      if (file) {
        if (file.size < 5 || file.size > 26214400 || !/\.pdf$/iu.test(file.name)) throw new Error('请选择不超过 25 MB 的 PDF')
        setNotice('正在核对文件；目标文档、原当前版本与会话代际已经固定…')
        const bytes = await file.arrayBuffer()
        if (!current(token)) return
        const contentHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
        if (!current(token)) return
        if (saved && (saved.upload.name !== file.name || saved.upload.byteLength !== file.size || saved.upload.contentHash !== contentHash)) throw new Error('此文件与原待办不一致。请选同一文件，或先明确弃用原本地待办。')
        if (!saved) {
          const upload: UploadStart = { schemaVersion: 1, kind: 'upload-start', idempotencyKey: `upload:${crypto.randomUUID()}`, name: file.name, byteLength: file.size, contentHash }
          saved = { schemaVersion: 1, owner: frozenOwner, expectedCurrentRevisionId, upload, uploadReceipt: null, importKey: `revision:${crypto.randomUUID()}`, request: null }
          savePendingVersion(sessionStorage, saved); restore()
        }
      }
      if (!saved) { setNotice('请先选择新版本 PDF。'); return }
      await process(saved, token, file)
    } catch (error) { if (current(token)) { restore(); setNotice(error instanceof Error ? `操作未完成：${error.message} 原键保留，不会换目标或自动更新来源。` : '版本导入尚未确认，原键保留。') } }
    finally { if (current(token)) { busyRef.current = false; setBusy(false) } }
  }
  function discard() {
    if (busyRef.current || outbox.state === 'empty' || !window.confirm('仅弃用此标签页的版本待办，不删除上传原件、旧版本或已完成的新版本，也不停止服务端作业。继续？')) return
    try { sessionStorage.removeItem(outbox.key); restore(); setJob(null); setNotice('仅弃用了本地待办。服务端原件和版本未撤回，请刷新历史核对。'); void load() } catch { setNotice('本地待办未能清除，原记录保留。') }
  }
  function read(entry: RevisionEntry, pane?: ReaderPane) {
    if (!owner) return
    const token = epoch.current, intent = onReadStart(pane)
    intents.current.add(intent.reject)
    try {
      if (!current(token)) { intent.reject(); return }
      const source = revisionOriginalSource(owner, entry)
      if (intent.complete(source)) onClose(); else intent.reject()
    } catch { intent.reject(); if (current(token)) setNotice('此历史版本的原始 PDF 暂不可用，未替换成最新版本或 Markdown。') }
    finally { intents.current.delete(intent.reject) }
  }
  const invalid = !owner || storageBlocked || outbox.state === 'invalid' || outbox.state === 'pending' && !outbox.current
  return <Drawer title="版本与更新" subtitle={`${document.displayName} · 每个版本独立保留；阅读和 A/B 对照不改变问题来源。`} onClose={onClose}>
    <div className="version-history">
      <p className="version-boundary">同一文档的不同版本可以同时用于提问。添加新版本不会替换已勾选版本，也不会改写旧问题或已保存的引用。</p>
      {notice && <p className="version-notice" role="status">{notice}</p>}
      <div className="version-actions"><button className="secondary-button" disabled={loading || busy || !owner} onClick={() => { const saved = restore(); void load(); if (saved.state === 'pending' && saved.current) void readStatus(saved.value) }}>{loading ? '读取中…' : '刷新版本与状态'}</button></div>
      {outbox.state !== 'empty' && <section className="version-pending" aria-label="待核对版本导入"><h3>保留了一次版本操作</h3>{outbox.state === 'pending' ? <><p>{outbox.value.upload.name} · {outbox.value.upload.byteLength} 字节</p><p>固定前驱：{outbox.value.expectedCurrentRevisionId}</p><details><summary>原操作键与阶段</summary><code>{outbox.value.upload.idempotencyKey}</code><code>{outbox.value.importKey}</code><p>{outbox.value.request ? '版本导入请求已冻结' : outbox.value.uploadReceipt ? '已有上传预留；版本导入尚未提交' : '上传预留回执未确认'}</p></details>{!outbox.current && <p>旧待办属于另一会话代际，不能改写为当前代际重试。</p>}</> : <p>旧待办无法完整校验，未修复或覆盖。</p>}
        <div className="version-actions"><button className="secondary-button" disabled={busy || invalid || !history} onClick={() => void start()}>使用原键继续同一版本导入</button><button className="text-action" disabled={busy || outbox.state !== 'pending' || !outbox.current} onClick={() => { if (outbox.state === 'pending') void readStatus(outbox.value) }}>仅查询原操作状态</button><button className="text-action" disabled={busy} onClick={discard}>仅弃用本地待办</button></div>
      </section>}
      {job && <p className="version-job" data-revision-job={job.job?.status ?? 'unconfirmed'}>{!job.job ? '导入尚未确认' : `${{ queued: '排队中', running: '处理中', succeeded: '已获得成功回执', failed: '处理失败', cancelled: '已取消' }[job.job.status]} · ${phases[job.job.phase]}`}</p>}
      <section className="version-upload"><h3>作为此文档的新版本</h3><p>目标文档固定为 {document.displayName}。其他文档已使用的文件或历史版本重复内容由服务器明确核对，不会根据文件名猜测关联。</p>
        {history && <small>提交时核对当前版本 {history.currentRevisionId}；之后即使服务端版本变化，也不自动替换该前置条件。</small>}
        <input ref={fileInput} type="file" accept="application/pdf,.pdf" aria-label="上传此文档新版本 PDF" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void start(file) }} />
        <button className="primary-button" disabled={busy || loading || invalid || !history} onClick={() => fileInput.current?.click()}>{busy ? '正在核对版本操作…' : outbox.state === 'pending' ? '重新选择原 PDF 续传' : '选择 PDF 作为此文档新版本'}</button>
        <p className="version-muted">最大 25 MB。刷新只查询状态，不重新上传或重新提交。关闭此面板不会撤销服务端作业。</p>
      </section>
      {history ? <><RevisionVersionList history={history} sourceRefs={state.sourceRefs} selectionDisabled={!owner || state.sending || state.request !== null} onRead={read} onSelect={(entry, selected) => {
        if (!owner || !current(epoch.current)) return
        try { client.setSources(revisionSourceChoice(client.state().sourceRefs, owner.documentId, entry.revision.revisionId, selected)) } catch { setNotice('未能保存版本勾选；已有问题的来源没有改变。') }
      }} />{history.nextCursor && <button className="text-action" disabled={loading || history.versions.length >= 256} onClick={() => void load(history.nextCursor!)}>更多历史版本</button>}{history.truncated && <p className="version-muted">当前是有界分页，不代表完整版本历史。{history.versions.length >= 256 ? '本次最多显示 256 个版本。' : '可继续读取下一页。'}</p>}</>
        : !loading && <p className="version-muted">尚未读到真实版本历史；不会编造版本或用当前文件替代旧版。</p>}
    </div>
  </Drawer>
}

export function RevisionVersionList({ history, sourceRefs, selectionDisabled, onRead, onSelect }: { history: ProductRevisionHistory, sourceRefs: LiveState['sourceRefs'], selectionDisabled: boolean,
  onRead(entry: RevisionEntry, pane?: ReaderPane): void, onSelect(entry: RevisionEntry, selected: boolean): void,
}) {
  return <section className="version-list" aria-label="文档版本历史"><h3>已保存版本</h3>{!history.versions.length && <p className="version-muted">此页没有可展示的版本。</p>}{history.versions.map(entry => {
    const revision = entry.revision, selected = sourceRefs.some(source => source.documentId === revision.documentId && source.revisionId === revision.revisionId)
    return <article key={revision.revisionId} data-document-revision={revision.revisionId}><header><strong>{revision.displayName}</strong><span>{revision.revisionId === history.currentRevisionId ? '当前逻辑版本' : '历史版本'}</span></header><p className="version-id">{revision.revisionId}</p><small>{revision.ingestedAt} · {revision.pageCount ?? '未知'} 页 · {revision.byteLength} 字节</small>
      <label className="version-source"><input type="checkbox" aria-label={`用于提问的版本：${revision.revisionId}`} checked={selected} disabled={selectionDisabled || !entry.source && !selected} onChange={event => onSelect(entry, event.target.checked)} />用于提问{!entry.source ? ' · 当前不能新增为可检索来源' : ''}</label>
      <div className="version-actions"><button className="text-action" disabled={!entry.original} onClick={() => onRead(entry)}>打开此版原始 PDF</button><button className="text-action" disabled={!entry.original} onClick={() => onRead(entry, 'A')}>放入对照 A</button><button className="text-action" disabled={!entry.original} onClick={() => onRead(entry, 'B')}>放入对照 B</button></div>
      {!entry.original && <p className="version-muted">该版本原件目前不可读，不会自动打开另一版本。</p>}
    </article>
  })}</section>
}
