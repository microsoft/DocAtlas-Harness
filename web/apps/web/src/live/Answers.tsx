import { useEffect, useMemo, useRef, useState } from 'react'
import type { AnswerManifest, CitationFocus, CitationPresentation, NativeConversationMessage } from '@docatlas/contracts'
import type { PdfQuote, PdfReaderSource } from '../PdfReader'
import type { LiveClient } from './client'
import { historyHeadKey, historyOriginKey } from './history-state'
import { AnswerMarkdown } from './AnswerMarkdown'
import { useUi } from './locale'

const relations = { support: '支持', refute: '反驳', qualify: '限定' }

/** Browser presentation only: source support is an Agent assertion, never a semantic verification badge. */
export function LiveAnswerBody({ manifest, busy, onCitation }: { manifest: AnswerManifest, busy: boolean, onCitation(citation: CitationPresentation): void }) {
  const { t, locale } = useUi()
  const citationAction = useRef(onCitation); citationAction.current = onCitation
  const citations = new Map(manifest.citations.map(citation => [citation.citationId, citation]))
  return useMemo(() => <div className="live-answer-body" data-manifest-status={manifest.manifestStatus}>
    {manifest.blocks.map(block => <AnswerMarkdown key={block.blockId} block={block} renderSegment={(segment, content) => <span data-answer-segment={segment.status}
      title={segment.status === 'unresolved' ? t('No clickable source is linked to this passage. This does not mean it has been judged false.', '这段内容尚未关联可点击的原文出处，不代表内容已被判定为错误。') : undefined}>{content}
      {segment.visibleCitationIds.map(id => {
        const citation = citations.get(id)
        if (!citation) return null
        if (citation.verificationStatus !== 'read-verified') return <small key={id} className="live-citation-unresolved" data-citation-state="locator-only">{t(`Location ${citation.ordinal} · p. ${citation.locator.physicalPage} (unverified)`, `定位线索 ${citation.ordinal} · 第 ${citation.locator.physicalPage} 页（未核验）`)}</small>
        return <button key={id} type="button" className={`citation live-citation ${citation.relation}`} disabled={busy} data-citation-id={citation.citationId}
          aria-label={t(`Citation ${citation.ordinal} · ${citation.relation} · page ${citation.locator.physicalPage}, open original PDF`, `引用 ${citation.ordinal} · ${relations[citation.relation]} · 第 ${citation.locator.physicalPage} 页，打开原始 PDF`)}
          title={t(`Page ${citation.locator.physicalPage} · ${citation.relation}. This is the agent's judgment; check the original source.`, `第 ${citation.locator.physicalPage} 页 · ${relations[citation.relation]}。这是 Agent 的判断，点击核对原始 PDF。`)}
          onClick={() => citationAction.current(citation)}><span>{citation.ordinal}</span>{citation.relation !== 'support' && <span aria-hidden="true" className="citation-relation-mark">{citation.relation === 'refute' ? '!' : '~'}</span>}</button>
      })}
    </span>} />)}
  </div>, [manifest, busy, locale])
}

export function LiveAnswer({ client, conversationId, message, onCitation }: {
  client: LiveClient, conversationId: string, message: NativeConversationMessage,
  onCitation(messageId: string, citation: CitationPresentation): Promise<void>,
}) {
  const { t, notice: uiNotice } = useUi()
  const [loaded, setLoaded] = useState<{ key: string, manifest: AnswerManifest | null } | null>(null)
  const [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [retry, setRetry] = useState(0)
  const snapshot = client.state().snapshot
  const key = JSON.stringify([conversationId, snapshot?.binding.bindingId, historyHeadKey(snapshot?.history.checkpoint, snapshot?.history.selectedHead),
    message.entryId, message.text, message.truncated, historyOriginKey(message.origin)])
  const visibleKey = useRef<string | null>(key); visibleKey.current = key
  useEffect(() => () => { visibleKey.current = null }, [])
  useEffect(() => {
    let current = true
    setNotice('')
    if (message.role !== 'assistant' || message.truncated) return
    void client.answerRequest(conversationId, message.entryId).then(result => {
      if (!current) return
      if (result.kind !== 'answer-response') throw new Error('Invalid answer response')
      setLoaded({ key, manifest: result.manifest })
    }).catch(() => { if (current) setNotice('引用暂时无法核对；保留原始回答，不启用未经核验的链接。') })
    return () => { current = false }
  }, [client, conversationId, message.entryId, message.role, message.truncated, key, retry])
  const manifest = loaded?.key === key ? loaded.manifest : null
  async function open(citation: CitationPresentation) {
    setBusy(true); setNotice('正在核对引用与原始 PDF…')
    try { await onCitation(message.entryId, citation); if (visibleKey.current === key) setNotice('') }
    catch { if (visibleKey.current === key) setNotice('当前无法核对这条引用，未打开其他版本或替代文本。') }
    finally { if (visibleKey.current === key) setBusy(false) }
  }
  const inherited = message.origin && message.origin.conversationId !== conversationId
  return <>{message.origin && <small className="live-answer-disclaimer">{t('From an earlier conversation or branch. Citations retain their original PDF version; this is not a new verification.', `${inherited ? '继承自原会话' : '来自先前分支'} · 引用仍指向当时的原始 PDF，不代表本次重新核验。`)}</small>}
    {manifest ? <LiveAnswerBody manifest={manifest} busy={busy} onCitation={citation => void open(citation)} /> : <><AnswerMarkdown text={message.text} />{message.text.includes('#docatlas.v1.') && <small className="live-citation-unresolved">{loaded?.key === key ? t('No verified source record is available for this answer.', '当前回答没有可用的引用记录，尚不能点击核对原文。') : t('Checking sources…', '正在核对出处…')}</small>}</>}
    {notice && <p className="live-answer-notice" role="status">{uiNotice(notice)}{!busy && <button className="text-action" onClick={() => setRetry(value => value + 1)}>{t('Retry source check', '重新核对引用')}</button>}</p>}
  </>
}

/** Build only the authenticated original-bytes route; no model/HTTP-provided URL is accepted. */
export function citationReaderTarget(conversationId: string, messageId: string, citation: CitationPresentation, result: CitationFocus): { source: PdfReaderSource, focus: PdfQuote } {
  if (citation.verificationStatus !== 'read-verified') throw new Error('Citation has no verified Read evidence')
  if (result.conversationId !== conversationId || result.messageId !== messageId || result.citationId !== citation.citationId
    || result.locator.locatorId !== citation.locator.locatorId || result.locator.documentId !== citation.locator.documentId
    || result.locator.revisionId !== citation.locator.revisionId || result.locator.representationId !== citation.locator.representationId
    || result.locator.representationContentHash !== citation.locator.representationContentHash
    || result.original.documentId !== result.locator.documentId || result.original.revisionId !== result.locator.revisionId
    || result.physicalPage !== result.locator.physicalPage || result.physicalPage !== citation.locator.physicalPage) throw new Error('Citation identity changed')
  const original = result.original, id = `${original.documentId}:${original.revisionId}`
  return {
    source: { id, name: original.name, kind: 'server', sha256: original.contentHash, pages: original.pageCount, bytes: original.byteLength,
      serverRevision: { documentId: original.documentId, revisionId: original.revisionId },
      url: `/api/conversations/${encodeURIComponent(conversationId)}/documents/${encodeURIComponent(original.documentId)}/${encodeURIComponent(original.revisionId)}/original` },
    focus: { documentId: id, page: result.physicalPage, quote: result.exactText ?? '', context: 'citation', resolution: result.status },
  }
}
