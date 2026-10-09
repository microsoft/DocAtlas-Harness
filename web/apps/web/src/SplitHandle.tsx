import { useEffect, useRef, useState, type PointerEvent } from 'react'

/** Ephemeral presentation state only; never changes a source, selection or chat. */
export function SplitHandle({ value, onChange }: { value: number, onChange: (value: number) => void }) {
  const handle = useRef<HTMLDivElement>(null)
  const [bounds, setBounds] = useState({ min: 38, max: 70 })
  const [dragging, setDragging] = useState(false)
  useEffect(() => {
    const element = handle.current
    const workspace = element?.parentElement
    if (!element || !workspace) return
    const observer = new ResizeObserver(() => {
      if (!element.offsetWidth) return // Mobile has a single workspace, not a divider.
      const width = workspace.clientWidth - element.offsetWidth
      const min = Math.max(38, Math.ceil(320 / width * 100))
      const max = Math.min(70, Math.floor((width - 340) / width * 100))
      if (min <= max) setBounds({ min, max })
    })
    observer.observe(workspace)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const next = Math.max(bounds.min, Math.min(bounds.max, value))
    if (next !== value) onChange(next)
  }, [bounds, value, onChange])

  function update(next: number) { onChange(Math.max(bounds.min, Math.min(bounds.max, Math.round(next)))) }
  function move(event: PointerEvent<HTMLDivElement>) {
    const element = handle.current
    const workspace = element?.parentElement
    if (!element || !workspace) return
    const box = workspace.getBoundingClientRect()
    update((event.clientX - box.left - element.offsetWidth / 2) / (workspace.clientWidth - element.offsetWidth) * 100)
  }

  return <div ref={handle} className={`split-handle ${dragging ? 'is-resizing' : ''}`} role="separator" tabIndex={0}
    aria-label="调整原文与对话宽度" aria-orientation="vertical" aria-controls="original-reader docatlas-chat"
    aria-valuemin={bounds.min} aria-valuemax={bounds.max} aria-valuenow={value} aria-valuetext={`原文 ${value}%，对话 ${100 - value}%`}
    title="拖动调整宽度 · 方向键微调 · 双击重置"
    onPointerDown={event => {
      if (event.button !== 0) return
      event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); setDragging(true)
    }} onPointerMove={event => { if (dragging) move(event) }}
    onPointerUp={event => { if (dragging) { move(event); setDragging(false); event.currentTarget.releasePointerCapture(event.pointerId) } }}
    onLostPointerCapture={() => setDragging(false)} onPointerCancel={() => setDragging(false)} onDoubleClick={() => update(58)}
    onKeyDown={event => {
      const next = event.key === 'ArrowLeft' ? value - 2 : event.key === 'ArrowRight' ? value + 2
        : event.key === 'Home' ? bounds.min : event.key === 'End' ? bounds.max : event.key === 'Enter' ? 58 : null
      if (next !== null) { event.preventDefault(); update(next) }
    }}><span /></div>
}
