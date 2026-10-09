import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TreeNode } from '@docatlas/contracts'
import { pdfSlots, pageAt, windowPages } from '../src/pdf-window'
import { outlineRows } from '../src/live/DocumentOutline'
import { initialUiLocale, UiLocaleProvider, LocaleSwitch } from '../src/live/locale'

describe('continuous original-PDF window', () => {
  it('keeps a bounded window with real page positions through a long document', () => {
    const slots = pdfSlots(1000, 612, 100, new Map([[1, 792 / 612]]))
    expect(slots[1]).toEqual({ page: 2, top: 816, width: 612, height: 792 })
    for (const number of [1, 2, 100, 998, 1000]) {
      const top = slots[number - 1]!.top
      expect(pageAt(slots, top + 100)).toBe(number)
      const window = windowPages(slots, top, 1000)
      expect(window.length).toBeLessThanOrEqual(5); expect(window.some(slot => slot.page === number)).toBe(true)
    }
  })
  it('supports mixed page aspect ratios and zoom without altering source page numbers', () => {
    const slots = pdfSlots(4, 612, 125, new Map([[1, 1], [2, 2], [3, .5]]))
    expect(slots.map(slot => slot.height)).toEqual([765, 1530, 382.5, 765])
    expect(slots[2]!.top).toBe(2343); expect(pageAt(slots, 2400)).toBe(3)
  })
  it('handles document boundaries and large viewports without unbounded canvases', () => {
    expect(pageAt([], 100)).toBe(1); expect(windowPages([], 0, 800)).toEqual([])
    expect(windowPages(pdfSlots(10000, 600, 75, new Map()), 0, 10000)).toHaveLength(5)
  })
})
describe('navigation-only outline hierarchy', () => {
  const node = (id: string, parentId: string | null, title: string): TreeNode => ({ nodeId: id, parentId, title, startPage: 1, endPage: 4, sourceNodeId: null, keyItems: [] })
  const nodes = [node('a', null, 'Methods'), node('b', 'a', 'Experiments'), node('c', 'b', 'Results'), node('d', null, 'Appendix')]
  it('collapses descendants, searches titles and retains physical-page nodes unchanged', () => {
    expect(outlineRows(nodes, new Set(['a']), '').map(row => row.node.nodeId)).toEqual(['a', 'd'])
    expect(outlineRows(nodes, new Set(['a']), 'results')).toEqual([{ node: nodes[2], depth: 2 }])
    expect(nodes[2]!.parentId).toBe('b')
  })
  it('bounds cycles and represents not-yet-loaded parents without fabricating nodes', () => {
    const page = [node('x', 'y', 'One'), node('y', 'x', 'Two'), node('z', 'unloaded', 'Three')]
    expect(outlineRows(page, new Set(), '')).toHaveLength(3)
    expect(outlineRows(page, new Set(), '')[2]!.depth).toBe(0)
  })
})
describe('interface-only language preference', () => {
  it('defaults to English, accepts only saved zh, and tolerates blocked storage', () => {
    expect(initialUiLocale()).toBe('en')
    expect(initialUiLocale({ getItem: () => 'zh' })).toBe('zh')
    expect(initialUiLocale({ getItem: () => 'fr' })).toBe('en')
    expect(initialUiLocale({ getItem() { throw new Error('blocked') } })).toBe('en')
  })
  it('renders explicit language controls without replacing user content', () => {
    const original = '用户的原文 remains unchanged'
    const html = renderToStaticMarkup(createElement(UiLocaleProvider, { initialLocale: 'en', children: [createElement(LocaleSwitch, { key: 'switch' }), original] }))
    expect(html).toContain('lang="en" aria-pressed="true"'); expect(html).toContain(original)
  })
})
