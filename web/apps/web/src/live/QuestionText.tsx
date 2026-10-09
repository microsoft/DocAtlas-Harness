import { memo, useId, useState } from 'react'
import { useUi } from './locale'

/** Collapsing changes only layout. The original submission/history text stays intact. */
export const QuestionText = memo(function QuestionText({ text }: { text: string }) {
  const { t } = useUi(), id = useId(), [expanded, setExpanded] = useState(false)
  const long = text.length > 420 || text.split('\n').length > 6
  return <div className={`question-content ${long && !expanded ? 'is-collapsed' : ''}`}>
    <p id={id}>{text}</p>
    {long && <button className="question-expand" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(value => !value)}>{expanded ? t('Show less', '收起问题') : t('Show full question', '展开完整问题')}</button>}
  </div>
})
