import { describe, expect, it } from 'vitest'
import { SAMPLE_DOCUMENT, SAMPLE_ID, classifyAnswer, demoReducer, initialDemoState, localPdfError, MAX_LOCAL_PDF_BYTES } from '../src/demo-state'

describe('prototype-only state and truthful answer routing', () => {
  const context = { documentId: SAMPLE_ID, page: 2, quote: 'Q4 15.2 +9%' }
  it('requires an explicitly selected sample for a scripted answer', () => {
    expect(classifyAnswer('总结这份报告', null, null)).toBe('unsupported')
    expect(classifyAnswer('总结这份报告', SAMPLE_DOCUMENT, null)).toBe('overview')
    expect(classifyAnswer('营收', SAMPLE_DOCUMENT, null)).toBe('revenue')
    expect(classifyAnswer('2026 风险', SAMPLE_DOCUMENT, null)).toBe('risk')
    expect(classifyAnswer('写一个排序算法', SAMPLE_DOCUMENT, null)).toBe('unsupported')
  })
  it('never gives an uploaded PDF sample-document claims, even with the same name/bytes', () => {
    const local = { ...SAMPLE_DOCUMENT, id: 'local:1', kind: 'local' as const }
    expect(classifyAnswer('总结报告营收', local, null)).toBe('local')
    expect(classifyAnswer('解释这段', local, context)).toBe('local')
    expect(classifyAnswer('解释这段', local, { ...context, documentId: local.id })).toBe('selection')
  })
  it('binds a selection to exactly one submission, then consumes the draft context', () => {
    let state = demoReducer(initialDemoState, { type: 'context', context })
    state = demoReducer(state, { type: 'submit', id: 'run:1', text: '解释', answer: 'selection' })
    expect(state.messages[0]?.context).toEqual(context)
    expect(state.run?.context).toEqual(context)
    expect(state.context).toBeNull()
    state = demoReducer(state, { type: 'complete', id: 'run:1' })
    expect(state.messages[1]?.context).toEqual(context)
    state = demoReducer(state, { type: 'submit', id: 'run:2', text: '下一问', answer: 'overview' })
    expect(state.run?.context).toBeNull()
  })
  it('clears selection on source change without changing the source of an active run', () => {
    let state = demoReducer(initialDemoState, { type: 'context', context })
    state = demoReducer(state, { type: 'submit', id: 'run:1', text: '解释', answer: 'selection' })
    state = demoReducer(state, { type: 'select-document', documentId: 'local:other' })
    expect(state.context).toBeNull()
    expect(state.run?.sourceId).toBe(SAMPLE_ID)
    expect(state.run?.context).toEqual(context)
  })
  it('does not start duplicate or blank submissions', () => {
    expect(demoReducer(initialDemoState, { type: 'submit', id: 'empty', text: ' ', answer: 'overview' })).toBe(initialDemoState)
    const running = demoReducer(initialDemoState, { type: 'submit', id: 'first', text: 'test', answer: 'unsupported' })
    expect(demoReducer(running, { type: 'submit', id: 'second', text: 'again', answer: 'overview' })).toBe(running)
  })
  it('ignores late completion after cancellation and after a new conversation', () => {
    const running = demoReducer(initialDemoState, { type: 'submit', id: 'first', text: 'test', answer: 'unsupported' })
    const cancelled = demoReducer(running, { type: 'cancel' })
    expect(cancelled.messages.at(-1)?.answer).toBe('cancelled')
    expect(demoReducer(cancelled, { type: 'complete', id: 'first' })).toBe(cancelled)
    const reset = demoReducer(running, { type: 'new-chat' })
    expect(demoReducer(reset, { type: 'phase', id: 'first' })).toBe(reset)
    expect(demoReducer(reset, { type: 'complete', id: 'first' }).messages).toHaveLength(0)
  })
  it('only explicit save creates notes, deduplicates them, and can remove them', () => {
    const state = demoReducer(initialDemoState, { type: 'context', context })
    expect(state.notes).toHaveLength(0)
    const saved = demoReducer(state, { type: 'save-note', note: { ...context, id: 'note:1' } })
    expect(demoReducer(saved, { type: 'save-note', note: { ...context, id: 'note:2' } })).toBe(saved)
    expect(demoReducer(saved, { type: 'new-chat' }).notes).toHaveLength(1)
    expect(demoReducer(saved, { type: 'remove-note', id: 'note:1' }).notes).toHaveLength(0)
  })
  it('style changes never change answer identity, evidence context or messages', () => {
    let state = demoReducer(initialDemoState, { type: 'context', context })
    state = demoReducer(state, { type: 'submit', id: 'first', text: 'test', answer: 'selection' })
    state = demoReducer(state, { type: 'complete', id: 'first' })
    const changed = demoReducer(state, { type: 'style', style: 'guided' })
    expect(changed.messages).toBe(state.messages)
    expect(changed.notes).toBe(state.notes)
  })
  it('bounds local file admission without uploading anything', () => {
    expect(localPdfError({ name: 'report.PDF', size: 20 })).toBeNull()
    expect(localPdfError({ name: 'report.html', size: 20 })).not.toBeNull()
    expect(localPdfError({ name: 'report.pdf', size: 0 })).not.toBeNull()
    expect(localPdfError({ name: 'report.pdf', size: MAX_LOCAL_PDF_BYTES + 1 })).not.toBeNull()
  })
})
