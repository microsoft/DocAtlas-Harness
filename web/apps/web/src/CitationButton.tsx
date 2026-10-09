import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './icons'
import { SAMPLE_DOCUMENT, type Citation, type QuoteContext } from './demo-state'

/** A preview is only a copy of the cited quote, never a replacement for its PDF. */
export function CitationButton({ citation, onOpen }: { citation: Citation, onOpen: (context: QuoteContext) => void }) {
  const id = useId()
  const anchor = useRef<HTMLButtonElement>(null)
  const preview = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout>>()
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0 })

  function show() { clearTimeout(closeTimer.current); setOpen(true) }
  function hide() { clearTimeout(closeTimer.current); setOpen(false) }
  function leave() { clearTimeout(closeTimer.current); closeTimer.current = setTimeout(() => setOpen(false), 150) }

  useEffect(() => () => clearTimeout(closeTimer.current), [])
  useLayoutEffect(() => {
    if (!open || !anchor.current || !preview.current) return
    const target = anchor.current.getBoundingClientRect()
    const box = preview.current.getBoundingClientRect()
    const left = Math.max(12, Math.min(target.left - 18, window.innerWidth - box.width - 12))
    const preferredTop = target.top - box.height - 10
    const top = Math.max(12, Math.min(preferredTop >= 12 ? preferredTop : target.bottom + 10, window.innerHeight - box.height - 12))
    setPosition({ left, top })
    const dismiss = () => setOpen(false)
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss() }
    // A scrolled-away anchor must not leave a detached floating preview behind.
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('keydown', key)
    }
  }, [open])

  return <><button ref={anchor} className="citation" aria-label={`引用 ${citation.number}：${citation.label}，第 ${citation.page} 页`}
    aria-describedby={open ? id : undefined} onPointerEnter={event => { if (event.pointerType === 'mouse') show() }}
    onPointerLeave={leave} onFocus={show} onBlur={hide} onClick={() => { hide(); onOpen(citation) }}>{citation.number}</button>
    {open && createPortal(<div ref={preview} id={id} role="tooltip" className="citation-preview" style={position}
      onPointerEnter={() => clearTimeout(closeTimer.current)} onPointerLeave={leave}>
      <div className="citation-preview-heading"><span><Icon name="link" size={14} />引用 {citation.number}</span><span>第 {citation.page} 页</span></div>
      <strong>{citation.label}</strong><blockquote>{citation.quote}</blockquote>
      <div className="citation-preview-source"><Icon name="file" size={14} /><span>{SAMPLE_DOCUMENT.name}</span></div>
      <p>点击引用，定位原始 PDF<Icon name="chevron" size={13} /></p>
    </div>, document.body)}
  </>
}
