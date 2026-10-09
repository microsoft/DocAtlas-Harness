import { useUi } from './locale'

export function WorkingIndicator({ label, small = false }: { label?: string, small?: boolean }) {
  const { t } = useUi()
  return <span className={`working-indicator ${small ? 'is-small' : ''}`} role="status" aria-label={label ?? t('Working on your question', '正在处理你的问题')}>
    <span className="working-orbit" aria-hidden="true"><i /><i /><i /></span>
    <span className="sr-only">{label ?? t('Working on your question', '正在处理你的问题')}</span>
  </span>
}
