import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../icons'
import { useUi } from './locale'
import './research-workspaces.css'

/** First-class research entry points; their existing controllers/outboxes stay mounted. */
export function ResearchActions({ children }: { children: ReactNode }) {
  const { t } = useUi(), [open, setOpen] = useState(false), root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  return <div className={`research-entry-group ${open ? 'is-open' : ''}`} ref={root}>
    <button ref={trigger} className="header-action research-menu-trigger" aria-label={t('Research tools', '研究工具')} aria-expanded={open} onClick={() => setOpen(value => !value)}><Icon name="note" size={17} /><span>{t('Research', '研究')}</span></button>
    <div className="research-entry-buttons" onKeyDown={event => { if (event.key === 'Escape' && open) { event.stopPropagation(); setOpen(false); trigger.current?.focus() } }}
      onClick={event => { if ((event.target as Element).closest('.header-action')?.parentElement === event.currentTarget) setOpen(false) }}>{children}</div>
  </div>
}
