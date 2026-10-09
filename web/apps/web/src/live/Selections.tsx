import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ProductSelectionProposal, ProductSelectionStage, VerifiedSelectionItem } from '@docatlas/contracts'
import { parseBrowserContract } from '@docatlas/contracts/browser'
import type { LiveClient, LiveState } from './client'
import type { PdfQuote, PdfReaderSource } from '../PdfReader'
import { useUi } from './locale'
import { Icon } from '../icons'
import { WorkingIndicator } from './WorkingIndicator'

export function LiveSelections({ client, state, proposed, onAdded, onReady, onReturn }: { client: LiveClient, state: LiveState, proposed: ProductSelectionProposal | null, onAdded(): void, onReady(): void, onReturn(source: PdfReaderSource, quote: PdfQuote): void }) {
  const { t, notice } = useUi()
  const [pending, setPending] = useState<ProductSelectionStage | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [invalid, setInvalid] = useState(false)
  const alive = useRef(true), conversationId = state.selected!
  const hold = useRef<(() => void) | undefined>(undefined), inFlight = useRef(false), attempted = useRef<ProductSelectionProposal | null>(null)
  const key = `docatlas.live.draft.v1:${encodeURIComponent(state.actor!.actorId)}:${encodeURIComponent(state.actor!.workspaceId)}:@selection:${encodeURIComponent(conversationId)}`
  useLayoutEffect(() => {
    alive.current = true
    try { const raw = sessionStorage.getItem(key); if (raw) { if (raw.length > 65536) throw new Error(); const value = parseBrowserContract('document-http', JSON.parse(raw)); if (value.kind !== 'selection-stage') throw new Error(); setPending(value) } }
    catch { setInvalid(true); setMessage('旧选区请求无法校验；未自动重试。') }
    return () => { alive.current = false; hold.current?.(); hold.current = undefined }
  }, [key])
  // Keep the send gate closed through failures/reloads as well as the network
  // call. A question must never silently omit the selection the user just chose.
  useLayoutEffect(() => {
    if (!(proposed || pending || invalid) || hold.current || state.request || state.sending) return
    try { hold.current = client.holdSelectionVerification() }
    catch { setMessage('另一项操作尚未结束，请稍后重试选区。') }
  }, [client, proposed, pending, invalid, state.request, state.sending])
  useEffect(() => {
    if (!proposed || attempted.current === proposed || pending || invalid || inFlight.current || !hold.current) return
    attempted.current = proposed
    void stage()
  }, [proposed, pending, invalid])
  function clear() { sessionStorage.removeItem(key); setPending(null); setInvalid(false); setMessage(''); onAdded(); hold.current?.(); hold.current = undefined }
  async function stage() {
    if (inFlight.current || invalid || client.state().request || client.state().sending || !state.snapshot || !pending && !proposed) return
    inFlight.current = true
    setBusy(true); setMessage('正在核对原文与版本…')
    try {
      hold.current ??= client.holdSelectionVerification()
      const request = pending ?? { schemaVersion: 1, kind: 'selection-stage', expectedGeneration: state.snapshot.binding.generation, idempotencyKey: `selection:${crypto.randomUUID()}`, proposals: [proposed!] } satisfies ProductSelectionStage
      sessionStorage.setItem(key, JSON.stringify(request)); setPending(request)
      const ticket = await client.documentRequest(conversationId, 'selections', request)
      if (!alive.current) return
      if (ticket.kind !== 'selection-ticket' || ticket.items.length !== request.proposals.length || ticket.items.some((item, index) => {
        const input = request.proposals[index]!
        return item.locator.documentId !== input.documentId || item.locator.revisionId !== input.revisionId || item.locator.physicalPage !== input.physicalPage || item.text.replace(/\s+/gu, ' ').trim() !== input.quote.replace(/\s+/gu, ' ').trim()
      })) throw new Error('选区回执与原请求不一致')
      client.addSelection(ticket); clear(); onReady()
    } catch { if (alive.current) setMessage('选区未能确认：可能过期、原文不匹配或有多处相同文字。保留原请求，可重试或重新选择。') }
    finally { inFlight.current = false; if (alive.current) setBusy(false) }
  }
  async function returnTo(item: VerifiedSelectionItem) {
    try {
      const value = await client.documentRequest(conversationId, `documents/${encodeURIComponent(item.locator.documentId)}`)
      if (!alive.current) return
      if (value.kind !== 'library-response' || value.result.resultType !== 'library-document') throw new Error()
      const document = value.result.document, revision = item.locator.revisionId, original = document.representations.find(item => item.kind === 'original-bytes' && item.mediaType === 'application/pdf')
      if (!original || document.currentRevision.revisionId !== revision) throw new Error()
      const id = `${document.documentId}:${revision}`
      onReturn({ id, name: document.displayName, kind: 'server', sha256: original.contentHash, bytes: original.byteLength, pages: original.pageCount ?? null,
        serverRevision: { documentId: document.documentId, revisionId: revision }, url: `/api/conversations/${encodeURIComponent(conversationId)}/documents/${encodeURIComponent(document.documentId)}/${encodeURIComponent(revision)}/original` }, { documentId: id, page: item.locator.physicalPage, quote: item.text })
    } catch { if (alive.current) setMessage('当前版本不可用，未跳到其他版本或页面。') }
  }
  return <section className="live-selections" aria-label={t('Question selections', '问题选区')}>
    {(proposed || pending || invalid) && <div className="selection-context selection-draft" data-selection-draft={busy ? 'verifying' : 'needs-attention'}>
      <div className="selection-card-heading"><Icon name="chat" size={14} /><strong>{busy ? t('Adding selected passage…', '正在加入所选段落…') : t('Selection needs attention', '选区尚未加入')}</strong>{busy && <WorkingIndicator small />}</div>
      <details className="selection-excerpt"><summary>{pending?.proposals[0]?.quote ?? proposed?.quote ?? t('Previous selection', '上次的选区')}</summary><blockquote>{pending?.proposals[0]?.quote ?? proposed?.quote}</blockquote></details>
      <p className="selection-guidance">{busy ? t('You can type your question while we check the original. Send will unlock when this passage is attached.', '可以先输入问题。原文核验完成并附上选区后，发送按钮会自动启用。') : t('This passage is not attached yet. Retry, or discard it to send without the selection.', '这段文字尚未附上。请重试，或舍弃选区后再发送。')}</p>
      <div className="selection-card-actions">{!busy && !invalid && <button type="button" className="selection-retry" disabled={!!state.request || state.sending} onClick={() => void stage()}>{t('Retry and add', '重试核验并加入')}</button>}
        <button type="button" disabled={busy} onClick={clear}>{t('Discard selection', '舍弃待核验选区')}</button></div>
    </div>}
    {state.selections.map(ticket => <div key={ticket.selectionContextId} className="selection-context" data-selection-ticket={ticket.selectionContextId}>
      {ticket.items.map(item => <div key={item.locator.locatorId}><div className="selection-card-heading"><Icon name="check" size={14} /><strong>{t(`Selected passage · page ${item.locator.physicalPage}`, `已附上选区 · 第 ${item.locator.physicalPage} 页`)}</strong><span>{Date.parse(ticket.expiresAt) <= Date.now() ? t('Expired — select again', '已过期，请重新选择') : t('Ready to ask', '可以提问')}</span></div>
        <details className="selection-excerpt"><summary>{item.text}</summary><blockquote>{item.text}</blockquote></details><button type="button" onClick={() => void returnTo(item)}>{t('View original selection', '回到选区原文')}</button></div>)}
      <button type="button" disabled={busy || !!state.request || state.sending} onClick={() => { setBusy(true); void client.removeSelection(ticket.selectionContextId).catch(() => setMessage('无法撤销已绑定或已消费选区，请核对提交状态。')).finally(() => { if (alive.current) setBusy(false) }) }}>{t('Remove selection', '移除此选区')}</button>
      <button type="button" disabled={busy || !!state.request || state.sending} onClick={() => { if (window.confirm(t('Remove this selection locally? Server tasks will not be stopped or deleted.', '仅从本地问题移除选区，不会停止或删除服务端任务。继续？'))) client.forgetSelection(ticket.selectionContextId) }}>{t('Remove locally only', '仅从本地移除')}</button>
    </div>)}
    {state.selections.length > 0 && !proposed && !pending && <p className="selection-guidance">{t('The passage will be included with your next question. Edit the question below, then press Send.', '所选段落会随下一条问题一起发送。请编辑下方问题，然后点击发送。')}</p>}
    {message && <p role={busy ? 'status' : 'alert'} className="selection-feedback">{notice(message)}</p>}
  </section>
}
