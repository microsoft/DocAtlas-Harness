import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Icon } from './icons'
import { useUi } from './live/locale'

export function Drawer({ title, subtitle, onClose, onDismiss, children, workspace = false }: { title: string, subtitle: string, onClose: () => void, onDismiss?: () => void, children: ReactNode, workspace?: boolean }) {
  const { t, notice } = useUi()
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const [leaving, setLeaving] = useState(false), dismissing = useRef(false), exitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  function dismiss() {
    if (dismissing.current) return
    dismissing.current = true
    if (ref.current) ref.current.inert = true
    // Revoke pending UI intent at the user's action, not after the exit animation.
    onDismiss?.()
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { onClose(); return }
    setLeaving(true); exitTimer.current = setTimeout(onClose, 120)
  }
  useEffect(() => {
    const previous = document.activeElement
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => { clearTimeout(exitTimer.current); if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [])

  return <div className={`drawer-backdrop ${workspace ? 'is-workspace' : ''} ${leaving ? 'is-leaving' : ''}`} onClick={event => { if (event.target === event.currentTarget) dismiss() }}>
    <div className={`drawer ${workspace ? 'drawer-workspace' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref} onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); dismiss() }
      if (event.key !== 'Tab') return
      const nodes = Array.from(ref.current?.querySelectorAll<HTMLElement>('button, input:not([type="file"]), textarea, select, summary, a[href], [tabindex]') ?? [])
        .filter(node => node.tabIndex >= 0 && !node.matches(':disabled, [aria-disabled="true"]') && node.getClientRects().length > 0)
      const first = nodes[0]
      const last = nodes.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }}>
      <div className="drawer-heading"><div><h2 id={titleId}>{notice(title)}</h2><p>{notice(subtitle)}</p></div><button className="icon-button" aria-label={t(`Close ${notice(title)}`, `关闭${title}`)} onClick={dismiss}><Icon name="close" /></button></div>
      <div className="drawer-content">{children}</div>
    </div>
  </div>
}
