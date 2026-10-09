import type { OutgoingMessage } from './outgoing-message'
import { QuestionText } from './QuestionText'
import { WorkingIndicator } from './WorkingIndicator'
import { useUi } from './locale'
import './outgoing-question.css'

export function OutgoingQuestion({ value, sending, error, onRetry }: { value: OutgoingMessage, sending: boolean, error: boolean, onRetry(): void }) {
  const { t } = useUi()
  return <article className="live-message user outgoing-question" data-outgoing-key={value.request.idempotencyKey} data-send-state={value.receipt ? 'accepted' : sending ? 'sending' : 'unconfirmed'} aria-label={t('Your message', '你的消息')}>
    {!!value.selections.length && <details className="outgoing-selections"><summary>{t('Selected passages', '选中的原文')}</summary>{value.selections.flatMap(ticket => ticket.items.map(item => <blockquote key={`${ticket.selectionContextId}:${item.locator.locatorId}`}><small>{t(`Page ${item.locator.physicalPage}`, `第 ${item.locator.physicalPage} 页`)}</small>{item.text}</blockquote>))}</details>}
    <QuestionText text={value.request.text} />
    <div className="outgoing-delivery" role="status">{sending && !value.receipt ? <WorkingIndicator small label={t('Sending message', '正在发送消息')} /> : value.receipt ? <span>{t('Received · syncing', '已接收 · 正在同步')}</span>
      : <><span>{t('Not confirmed', '尚未确认')}</span>{error && <button className="text-action" onClick={onRetry}>{t('Retry same message', '重试这条消息')}</button>}</>}</div>
  </article>
}
