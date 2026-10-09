import { useEffect, useRef, useState } from 'react'
import type { LibraryDocumentSummary, UploadStart } from '@docatlas/contracts'
import { parseBrowserContract } from '@docatlas/contracts/browser'
import { Drawer } from '../Drawer'
import { Icon } from '../icons'
import type { PdfReaderSource } from '../PdfReader'
import type { LiveClient, LiveState } from './client'
import { LiveEnrichments } from './Enrichments'
import { VersionHistory } from './VersionHistory'
import { revisionSourceChoice } from './version-state'
import type { ReaderPane } from './reader-state'
import { parsePendingUpload, uploadQuestionMatches, type PendingUpload } from './upload-state'
import { useUi } from './locale'

export interface IncomingUpload { id: number, conversationId: string, bindingId: string, generation: number, file: File }
export function LiveLibrary({ client, state, onReadStart, openRequest, onPickFile, incomingUpload, onUploadConsumed, onBusyChange }: { client: LiveClient, state: LiveState,
  onReadStart(pane?: ReaderPane): { complete(source: PdfReaderSource): boolean, reject(): void }, openRequest?: { id: number, pane: ReaderPane } | undefined,
  onPickFile(): void, incomingUpload?: IncomingUpload | undefined, onUploadConsumed(): void, onBusyChange(value: boolean): void,
}) {
  const { t, notice: uiNotice } = useUi()
  const [open, setOpen] = useState(false), [documents, setDocuments] = useState<LibraryDocumentSummary[]>([]), [cursor, setCursor] = useState<string | undefined>()
  const [pending, setPending] = useState<PendingUpload | null>(null), [busy, setBusy] = useState(false), [notice, setNotice] = useState('')
  const [enhance, setEnhance] = useState<LibraryDocumentSummary | null>(null)
  const [versions, setVersions] = useState<LibraryDocumentSummary | null>(null)
  const [target, setTarget] = useState<ReaderPane | undefined>()
  const alive = useRef(true), busyRef = useRef(false), consumedUpload = useRef<number | undefined>()
  const readingIntents = useRef(new Set<() => void>())
  const conversationId = state.selected!
  const key = `docatlas.live.draft.v1:${encodeURIComponent(state.actor!.actorId)}:${encodeURIComponent(state.actor!.workspaceId)}:@upload:${encodeURIComponent(conversationId)}`
  function remember(value: PendingUpload | null) { if (value) sessionStorage.setItem(key, JSON.stringify(value)); else sessionStorage.removeItem(key); setPending(value) }
  function rejectReading() { for (const reject of readingIntents.current) reject(); readingIntents.current.clear() }
  function closeLibrary() { rejectReading(); setOpen(false) }
  function showLibrary() { setVersions(null); setTarget(undefined); setOpen(true); void list().catch(() => setNotice('文档列表暂不可用，请稍后重试。')) }
  function changeBusy(value: boolean) { busyRef.current = value; setBusy(value); onBusyChange(value) }
  async function list(after?: string) {
    const value = await client.documentRequest(conversationId, `documents${after ? `?cursor=${encodeURIComponent(after)}` : ''}`)
    if (!alive.current) return
    if (value.kind !== 'library-response' || value.result.resultType !== 'library-documents') throw new Error('Invalid Library list')
    const result = value.result
    setDocuments(items => after ? [...items, ...result.documents] : result.documents); setCursor(result.pageInfo.nextCursor)
  }
  useEffect(() => {
    alive.current = true
    try {
      const raw = sessionStorage.getItem(key)
      if (raw) setPending(parsePendingUpload(raw, conversationId))
    } catch { setNotice('旧上传记录无法校验；未自动重传。') }
    void list().catch(() => { /* The explicit Library action can retry; no upload or selection is inferred here. */ })
    return () => { alive.current = false; onBusyChange(false); for (const reject of readingIntents.current) reject(); readingIntents.current.clear() }
  }, [key, conversationId])
  useEffect(() => {
    if (!incomingUpload || incomingUpload.conversationId !== conversationId || consumedUpload.current === incomingUpload.id || busyRef.current) return
    consumedUpload.current = incomingUpload.id; onUploadConsumed()
    if (incomingUpload.bindingId !== state.snapshot?.binding.bindingId || incomingUpload.generation !== state.snapshot?.binding.generation) { setNotice('会话已变化，请重新选择要上传的文件。'); return }
    void upload(incomingUpload.file)
  }, [incomingUpload?.id, conversationId])
  useEffect(() => { if (openRequest) { setVersions(null); setTarget(openRequest.pane); setOpen(true); void list().catch(() => setNotice('资料服务暂不可用')) } }, [openRequest?.id])
  async function process(value: PendingUpload) {
    if (!value.receipt) throw new Error('请选择原文件继续上传')
    const receipt = await client.documentRequest(conversationId, `uploads/${encodeURIComponent(value.receipt.uploadId)}`)
    if (receipt.kind !== 'upload' || receipt.conversationId !== conversationId || receipt.contentHash !== value.request.contentHash
      || receipt.byteLength !== value.request.byteLength || receipt.name !== value.request.name || receipt.status !== 'stored') throw new Error('文件尚未完整保存，请重新选择相同文件')
    await client.documentRequest(conversationId, `uploads/${encodeURIComponent(receipt.uploadId)}/import`, {})
    const deadline = Date.now() + 120000
    while (alive.current) {
      const job = await client.documentRequest(conversationId, `uploads/${encodeURIComponent(receipt.uploadId)}/job`)
      if (!alive.current) return
      if (job.kind !== 'library-response' || job.result.resultType !== 'library-job') throw new Error('Invalid import state')
      if (job.result.status === 'succeeded') {
        const document = job.result.document
        if (!document || document.workspaceId !== state.actor!.workspaceId || document.status === 'archived'
          || document.currentRevision.contentHash !== value.request.contentHash || document.currentRevision.byteLength !== value.request.byteLength) throw new Error('无法核对上传文档，请在资料中确认，未改变提问来源。')
        const current = client.state()
        if (uploadQuestionMatches(value, current.snapshot?.binding) && current.selected === conversationId && current.snapshot?.binding.bindingId === state.snapshot?.binding.bindingId
          && current.snapshot?.binding.generation === state.snapshot?.binding.generation && !current.request && !current.sending) {
          client.setSources(revisionSourceChoice(current.sourceRefs, document.documentId, document.currentRevision.revisionId, true))
          setNotice('已添加，可以提问了。')
        } else setNotice('文档已保存；可在资料中选择用于提问。')
        remember(null); await list(); return
      }
      if (['failed', 'cancelled'].includes(job.result.status)) throw new Error('资料解析失败或已取消，未加入可提问来源。请检查文件后重新上传。')
      setNotice('正在读取 PDF，完成后即可提问…')
      if (Date.now() >= deadline) throw new Error('资料仍在处理。稍后点击「继续处理」核对状态，不会重跑模型。')
      await new Promise(resolve => setTimeout(resolve, 750))
    }
  }
  async function upload(file: File | undefined) {
    if (!file || busyRef.current) return
    changeBusy(true); setNotice('正在上传 PDF…')
    try {
      if (file.size < 5 || file.size > 26214400 || !/\.pdf$/i.test(file.name)) throw new Error('请选择不超过 25 MB 的 PDF')
      const bytes = await file.arrayBuffer(), contentHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
      if (!alive.current) return
      if (pending && (pending.request.contentHash !== contentHash || pending.request.name !== file.name || pending.request.byteLength !== file.size)) throw new Error('请继续选择上次的同一文件，或先清除本地上传记录。')
      const request: UploadStart = pending?.request ?? { schemaVersion: 1, kind: 'upload-start', idempotencyKey: `upload:${crypto.randomUUID()}`, name: file.name, byteLength: file.size, contentHash }
      const binding = state.snapshot?.binding
      if (!binding) throw new Error('会话尚未准备好，请稍后上传。')
      const attachToQuestion = { bindingId: binding.bindingId, generation: binding.generation }
      parseBrowserContract('document-http', request); remember({ request, receipt: pending?.receipt ?? null, attachToQuestion })
      const receipt = await client.documentRequest(conversationId, 'uploads', request)
      if (receipt.kind !== 'upload' || receipt.conversationId !== conversationId || receipt.contentHash !== contentHash || receipt.byteLength !== file.size || receipt.name !== file.name) throw new Error('Upload identity mismatch')
      const value = { request, receipt, attachToQuestion }; if (!alive.current) return; remember(value)
      if (receipt.status !== 'stored') await client.uploadBytes(conversationId, receipt.uploadId, file)
      if (alive.current) await process(value)
    } catch (error) { if (alive.current) setNotice(error instanceof Error ? error.message : '上传未完成；未改变提问来源。') }
    finally { if (alive.current) changeBusy(false) }
  }
  async function read(summary: LibraryDocumentSummary, pane?: ReaderPane) {
    const intent = onReadStart(pane), documentId = summary.documentId
    readingIntents.current.add(intent.reject)
    try {
      const value = await client.documentRequest(conversationId, `documents/${encodeURIComponent(documentId)}`)
      if (!alive.current) return
      if (value.kind !== 'library-response' || value.result.resultType !== 'library-document') throw new Error('Invalid document')
      const document = value.result.document, original = document.representations.find(item => item.kind === 'original-bytes' && item.mediaType === 'application/pdf')
      if (!original || document.documentId !== documentId || document.currentRevision.revisionId !== summary.currentRevisionId) throw new Error('此资料的版本已变化，请刷新列表后重新选择原始 PDF')
      const accepted = intent.complete({ id: `${documentId}:${document.currentRevision.revisionId}`, serverRevision: { documentId, revisionId: document.currentRevision.revisionId }, name: document.displayName, kind: 'server', sha256: original.contentHash, bytes: original.byteLength, pages: original.pageCount ?? null,
        url: `/api/conversations/${encodeURIComponent(conversationId)}/documents/${encodeURIComponent(documentId)}/${encodeURIComponent(document.currentRevision.revisionId)}/original` })
      if (accepted) setOpen(false)
    } catch (error) { intent.reject(); if (alive.current) setNotice(error instanceof Error ? error.message : '无法读取原件') }
    finally { readingIntents.current.delete(intent.reject) }
  }
  return <><button type="button" className="header-action live-library-button" onClick={showLibrary}><Icon name="file" size={17} />{t('Library', '资料')}{state.sourceRefs.length ? ` · ${state.sourceRefs.length}` : ''}</button>
    {!!state.sourceRefs.length && <div className="live-source-chips" aria-label={t('Documents for this question', '本次提问的文档')}>{state.sourceRefs.map(source => {
      const document = documents.find(item => item.documentId === source.documentId && item.currentRevisionId === source.revisionId)
      const name = document?.displayName ?? `文档 ${source.documentId.slice(-8)}`
      return <div className="live-source-chip" key={`${source.documentId}:${source.revisionId}`}><button type="button" title={t(`Open original PDF: ${name}`, `打开原始 PDF：${name}`)} onClick={() => document ? void read(document, undefined) : showLibrary()}><Icon name="file" size={14} /><span>{name}</span></button>
        <button type="button" aria-label={t(`Remove question document: ${name}`, `移除提问文档：${name}`)} disabled={state.sending || !!state.request} onClick={() => { try { client.setSources(revisionSourceChoice(client.state().sourceRefs, source.documentId, source.revisionId, false)) } catch (error) { setNotice(error instanceof Error ? error.message : '暂时无法移除文档。') } }}><Icon name="close" size={13} /></button></div>
    })}</div>}
    {!open && notice && <p className="live-upload-status" role="status">{uiNotice(notice)}{pending && !busy && <button className="text-action" onClick={showLibrary}>{t('View and continue', '查看并继续')}</button>}</p>}
    {!open && pending && !notice && <button className="text-action" onClick={showLibrary}>{t('Continue previous upload:', '继续处理上次上传：')}{pending.request.name}</button>}
    {open && <Drawer title={t('Library', '资料')} subtitle={target ? t(`Open an original in ${target}. Question documents will not change.`, `选择放入 ${target} 的原文；不会改变提问文档。`) : t('Add a PDF or select documents for this question.', '上传 PDF，或选择已有文档用于本次提问。')} onDismiss={rejectReading} onClose={closeLibrary}>
      <button className="upload-area" disabled={busy || !!state.request || state.sending} onClick={onPickFile}><Icon name="upload" /><strong>{busy ? t('Preparing…', '正在处理…') : t('Upload PDF', '上传 PDF')}</strong><span>{t('Upload and ask · up to 25 MB', '上传并用于本次提问 · 最大 25 MB')}</span></button>
      {notice && <p className="live-notice" role="status">{uiNotice(notice)}</p>}
      {pending && <div className="live-outbox"><p>待核对：{pending.request.name}。刷新不自动重传。</p><button disabled={busy} onClick={() => { changeBusy(true); void process(pending).catch(error => { if (alive.current) setNotice(String(error.message)) }).finally(() => { if (alive.current) changeBusy(false) }) }}>继续处理</button><button disabled={busy} onClick={() => { remember(null); setNotice('仅清除本地上传记录；未删除服务端原件。') }}>清除本地上传记录</button></div>}
      <div className="document-list">{documents.map(document => {
        const selected = state.sourceRefs.some(ref => ref.documentId === document.documentId && ref.revisionId === document.currentRevisionId)
        return <div className="document-card live-library-document" key={document.documentId} data-library-document={document.documentId} data-library-revision={document.currentRevisionId}><label className="document-select"><input type="checkbox" checked={selected} aria-label={t(`Use for questions: ${document.displayName}`, `用于提问：${document.displayName}`)} disabled={state.sending || state.request !== null || document.status === 'archived'} onChange={() => {
          try { client.setSources(revisionSourceChoice(client.state().sourceRefs, document.documentId, document.currentRevisionId, !selected)) } catch { setNotice('无法保存来源选择，未发送问题。') }
        }} /><span className="document-card-info"><strong>{document.displayName}</strong><small>{document.status === 'ready' ? t('Ready to ask', '可以提问') : document.status === 'partial' ? t('Partially readable', '部分可读 · 仍需核验') : t('Archived', '已归档')}</small></span></label><div className="live-library-actions"><button className="text-action" onClick={() => void read(document, target)}>{target ? t(`Open in ${target}`, `放入 ${target}`) : t('Open original', '打开原文')}</button>{document.mediaType === 'application/pdf' && <details className="live-document-more"><summary>{t('More', '更多')}</summary><div><button className="text-action" onClick={() => void read(document, 'A')}>{t('Compare in A', '放入对照 A')}</button><button className="text-action" onClick={() => void read(document, 'B')}>{t('Compare in B', '放入对照 B')}</button><button className="text-action" onClick={() => { setVersions(document); closeLibrary() }}>{t('Versions', '版本与更新')}</button><button className="text-action" onClick={() => { setEnhance(document); closeLibrary() }}>{t('Enhance with Flash', 'Flash 增强')}</button></div></details>}</div></div>
      })}</div>
      {cursor && <button className="text-action" onClick={() => void list(cursor).catch(() => setNotice('无法加载下一页'))}>{t('More documents', '更多资料')}</button>}
      {!documents.length && !busy && <p className="drawer-footnote">{t('No documents yet. Upload a PDF to begin.', '还没有文档。上传一份 PDF 就能开始。')}</p>}
      <p className="drawer-footnote">{t('Selected documents are used for this question. Unchecking never deletes the original.', '勾选的文档用于本次提问。移除勾选不会删除原件。')}</p>
      <button className="primary-button drawer-done" onClick={closeLibrary}>{t('Back to chat', '回到对话')}</button>
    </Drawer>}{enhance && <LiveEnrichments client={client} state={state} document={enhance} onClose={() => setEnhance(null)} />}{versions && <VersionHistory key={`${key}:${versions.documentId}`} client={client} state={state} document={versions} onReadStart={onReadStart} onClose={() => setVersions(null)} onImported={() => { void list().catch(() => setNotice('请刷新资料列表核对新版本')) }} />}
  </>
}
