import { useEffect, useRef, useState } from 'react'
import type { QuestionContext, QuestionContextTarget, QuestionPassage } from '@docatlas/contracts'
import type { LiveClient } from './client'
import { useUi } from './locale'
import { Icon } from '../icons'
import { WorkingIndicator } from './WorkingIndicator'
import './question-context.css'

/** Input provenance stays beside both sides of the exchange; it is not an answer citation. */
export function LiveQuestionContext({ client, conversationId, target, version, answer = false, onOriginal }: {
  client: LiveClient, conversationId: string, target: QuestionContextTarget, version: string, answer?: boolean,
  onOriginal(target: QuestionContextTarget, passage: QuestionPassage): Promise<void>,
}) {
  const { t } = useUi(), anchor = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false), [value, setValue] = useState<QuestionContext | null>(null), [expanded, setExpanded] = useState(!answer)
  const [opening, setOpening] = useState<string | null>(null), [error, setError] = useState(false)
  const identity = `${conversationId}:${target.kind}:${target.id}:${version}`, owner = useRef(identity); owner.current = identity
  useEffect(() => {
    const element = anchor.current
    if (!element) return
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect() } }, { rootMargin: '160px' })
    observer.observe(element); return () => observer.disconnect()
  }, [])
  useEffect(() => {
    let gone = false
    setValue(null); setError(false)
    if (visible) void client.questionContextRequest(conversationId, target).then(result => {
      if (!gone && result.kind === 'question-context') setValue(result)
    }).catch(() => { /* No guessed context: disclosure can only follow a verified response. */ })
    return () => { gone = true }
  }, [client, identity, visible])
  async function open(passage: QuestionPassage) {
    const key = `${passage.selectionContextId}:${passage.locatorId}`, before = identity
    setOpening(key); setError(false)
    try { await onOriginal(target, passage) }
    catch { if (owner.current === before) setError(true) }
    finally { if (owner.current === before) setOpening(null) }
  }
  if (!value || value.status === 'none' || value.status === 'unavailable' && value.reason === 'history') return <div ref={anchor} className="question-context-anchor" />
  if (value.status === 'unavailable') return <div ref={anchor} className="question-context-unavailable"><Icon name="file" size={12} />{t('Original selection is unavailable', '原始选区暂不可用')}</div>
  const first = value.passages[0]!
  return <div ref={anchor} className={`question-context-card ${answer ? 'is-answer-context' : ''}`} data-question-context={target.id}>
    <button type="button" className="question-context-heading" aria-expanded={expanded} title={first.original.name} onClick={() => setExpanded(old => !old)}>
      <Icon name="quote" size={14} /><span>{answer ? t('About your selection', '针对所选原文') : t('Selected passage', '选中的原文')}</span>
      {answer && !expanded && <span className="question-context-teaser">{first.text}</span>}
      <small>{value.passages.length > 1 ? t(`${value.passages.length} passages`, `${value.passages.length} 段`) : t(`p. ${first.physicalPage}`, `第 ${first.physicalPage} 页`)}</small><Icon name="chevron" size={12} style={{ transform: expanded ? 'rotate(90deg)' : undefined }} />
    </button>
    {expanded && <div className="question-context-passages">{value.passages.map(passage => <div key={`${passage.selectionContextId}:${passage.locatorId}`} className="question-context-passage">
      <button type="button" className="question-context-source" title={passage.original.name} disabled={opening !== null} onClick={() => void open(passage)} aria-label={t(`Open selected passage in ${passage.original.name}, page ${passage.physicalPage}`, `回到 ${passage.original.name} 第 ${passage.physicalPage} 页的选区`)}>
        <Icon name="file" size={13} /><span>{passage.original.name}</span><small>{t(`p. ${passage.physicalPage}`, `第 ${passage.physicalPage} 页`)}</small>{opening === `${passage.selectionContextId}:${passage.locatorId}` ? <WorkingIndicator small /> : <Icon name="arrow" size={13} />}
      </button>
      <PassageText text={passage.text} />
    </div>)}{!answer && value.selectionState === 'attached' && <small className="question-context-stage">{t('Attached to this question', '已附在本次问题中')}</small>}</div>}
    {error && <p className="question-context-error" role="alert">{t('This original selection could not be opened. Its source or permissions may have changed.', '暂时无法打开原始选区，来源或权限可能已变化。')}</p>}
  </div>
}

export function PassageText({ text }: { text: string }) {
  const { t } = useUi(), [full, setFull] = useState(false), long = text.length > 160 || text.split('\n').length > 3
  return <><blockquote className={`question-context-quote ${full ? 'is-expanded' : ''}`}>{text}</blockquote>{long && <button type="button" className="question-context-expand" aria-expanded={full} onClick={() => setFull(value => !value)}>{full ? t('Show less', '收起原文') : t('Read full passage', '展开完整选区')}</button>}</>
}
