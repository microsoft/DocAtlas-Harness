import { describe, expect, it } from 'vitest'
import type { PdfReaderSource } from '../src/PdfReader'
import { ReaderNavigation, readerSourceIdentity } from '../src/live/reader-state'
import { readerPaneVisible } from '../src/live/CompareReaders'
import { initialPdfView, pdfRestoreIsCurrent, restoredPdfTop, validPdfView } from '../src/pdf-view-state'

function source(revision: string, documentId = 'document:same'): PdfReaderSource {
  return { id: `${documentId}:${revision}`, name: '同名报告.pdf', kind: 'server', sha256: revision.endsWith('b') ? 'b'.repeat(64) : 'a'.repeat(64), pages: 6, bytes: 1234,
    serverRevision: { documentId, revisionId: revision }, url: `/api/conversations/conversation:one/documents/${documentId}/${revision}/original` }
}
function setup() { const navigation = new ReaderNavigation(); navigation.reset('actor:one/workspace:one/conversation:one/binding:one'); return navigation }

describe('independent live original-PDF cursors and return stacks', () => {
  it('keeps chat shell stable for viewport frames while back uses the exact latest position', () => {
    const navigation = setup(), a = source('revision:a'); navigation.complete(navigation.begin(), a)
    const shell = navigation.shellState(), view = initialPdfView(a, 1)
    for (let index = 1; index <= 240; index++) navigation.view('A', { ...view, scrollTop: index, scrollHeight: 1800, viewportHeight: 700 })
    expect(navigation.shellState()).toBe(shell)
    expect(navigation.state().panes.A.location!.view.scrollTop).toBe(240)
    navigation.complete(navigation.begin(), source('revision:b')); navigation.back('A')
    expect(navigation.state().panes.A.location!.view.scrollTop).toBe(240)
    expect(navigation.shellState()).toBe(navigation.state())
    const pending = navigation.begin(); navigation.interact('A')
    expect(navigation.complete(pending, source('revision:c'))).toBe(false)
  })
  it('updates the visible page without creating navigation history, altering the other pane or changing identity', () => {
    const navigation = setup(), a = source('revision:a'); navigation.complete(navigation.begin('A'), a)
    const before = structuredClone(navigation.state())
    navigation.visiblePage('A', readerSourceIdentity(a), 3)
    expect(navigation.state().panes.A.location).toMatchObject({ page: 3, view: { page: 3, layout: 'continuous' } })
    expect(navigation.state().panes.A.back).toEqual(before.panes.A.back)
    expect(navigation.state().panes.A.navigation).toBe(before.panes.A.navigation)
    expect(navigation.state().panes.B).toEqual(before.panes.B)
    for (const page of [0, 7, NaN]) navigation.visiblePage('A', readerSourceIdentity(a), page)
    navigation.visiblePage('A', 'foreign', 4)
    expect(navigation.state().panes.A.location!.page).toBe(3)
  })
  it('retains two same-name source revisions, independent pages, zoom and scroll without adding Agent scope', () => {
    const navigation = setup(), a = source('revision:a'), b = source('revision:b')
    expect(navigation.state().visible).toBe(false)
    navigation.complete(navigation.begin('A'), a); navigation.complete(navigation.begin('B'), b)
    navigation.page('A', readerSourceIdentity(a), 2); navigation.page('B', readerSourceIdentity(b), 5)
    navigation.view('A', { ...initialPdfView(a, 2, 150), scrollTop: 140, scrollHeight: 1300, viewportHeight: 600 })
    navigation.view('B', { ...initialPdfView(b, 5, 75), scrollTop: 320, scrollHeight: 1200, viewportHeight: 500 })
    const state = navigation.state()
    expect(state.panes.A.location).toMatchObject({ source: { serverRevision: { revisionId: 'revision:a' } }, page: 2, view: { zoom: 150, scrollTop: 140 } })
    expect(state.panes.B.location).toMatchObject({ source: { serverRevision: { revisionId: 'revision:b' } }, page: 5, view: { zoom: 75, scrollTop: 320 } })
    expect(state).not.toHaveProperty('sourceRefs'); expect(readerSourceIdentity(a)).not.toBe(readerSourceIdentity(b))
    a.name = 'changed externally.pdf'; expect(state.panes.A.location!.source.name).toBe('同名报告.pdf')
  })

  it('publishes independently requested A/B sources out of order without changing the last chosen pane', () => {
    const navigation = setup(), first = navigation.begin('A'), second = navigation.begin('B')
    expect(navigation.complete(second, source('revision:b'))).toBe(true)
    expect(navigation.complete(first, source('revision:a'))).toBe(true)
    expect(navigation.state().active).toBe('B'); expect(navigation.state().panes.A.location).not.toBeNull()
    const stale = navigation.begin('A'), current = navigation.begin('A')
    expect(navigation.complete(stale, source('revision:stale'))).toBe(false)
    expect(navigation.complete(current, source('revision:current'))).toBe(true)
  })

  it('ignores late metadata/citation responses after page interaction, close, or actor/workspace/conversation reset', () => {
    const navigation = setup(), a = source('revision:a'); navigation.complete(navigation.begin(), a)
    const beforePage = navigation.begin(); navigation.page('A', readerSourceIdentity(a), 3)
    expect(navigation.complete(beforePage, source('revision:b'))).toBe(false)
    const beforeWheel = navigation.begin(); navigation.interact('A')
    expect(navigation.complete(beforeWheel, source('revision:b'))).toBe(false)
    const beforeClose = navigation.begin(); navigation.close()
    expect(navigation.complete(beforeClose, source('revision:b'))).toBe(false); expect(navigation.state().visible).toBe(false)
    const beforeReset = navigation.begin(); navigation.reset('actor:other/workspace:other/conversation:other/binding:other')
    expect(navigation.complete(beforeReset, a)).toBe(false); expect(navigation.state().panes.A.location).toBeNull(); expect(navigation.state().panes.B.location).toBeNull()
  })

  it('returns from a citation to the exact previous source, page and viewport without moving the other pane', () => {
    const navigation = setup(), a = source('revision:a'), b = source('revision:b')
    navigation.complete(navigation.begin('A'), a); navigation.complete(navigation.begin('B'), b)
    navigation.page('A', readerSourceIdentity(a), 4)
    navigation.view('A', { ...initialPdfView(a, 4, 150), scrollTop: 277, scrollLeft: 20, scrollHeight: 1600, viewportHeight: 700 })
    const previous = structuredClone(navigation.state().panes.A.location), untouched = structuredClone(navigation.state().panes.B)
    const intent = navigation.begin('A'), quote = { documentId: a.id, page: 2, quote: 'Actual citation text', context: 'citation' as const, resolution: 'resolved' as const }
    navigation.complete(intent, a, quote, { messageId: 'message:cited', scrollTop: 460 })
    expect(navigation.state().panes.A).toMatchObject({ restore: 'focus', location: { page: 2, answer: { messageId: 'message:cited', scrollTop: 460 } } })
    expect(navigation.state().panes.B).toEqual(untouched)
    navigation.back('A')
    expect(navigation.state().panes.A.location).toEqual(previous); expect(navigation.state().panes.A.restore).toBe('position')
    expect(navigation.state().panes.B).toEqual(untouched)
  })

  it('binds selections to the pane that actually rendered the source/page and keeps A/B selections separate', () => {
    const navigation = setup(), a = source('revision:a'), b = source('revision:b')
    navigation.complete(navigation.begin('A'), a); navigation.complete(navigation.begin('B'), b)
    navigation.page('A', readerSourceIdentity(a), 2); navigation.page('B', readerSourceIdentity(b), 4)
    const qa = { documentId: a.id, page: 2, quote: 'A original quote' }, qb = { documentId: b.id, page: 4, quote: 'B original quote' }
    expect(navigation.select('A', readerSourceIdentity(b), qa)).toBeNull()
    expect(navigation.select('A', readerSourceIdentity(a), { ...qa, page: 4 })).toBeNull()
    expect(navigation.select('A', readerSourceIdentity(a), qa)).toEqual({ ...a.serverRevision, physicalPage: 2, quote: qa.quote })
    expect(navigation.select('B', readerSourceIdentity(b), qb)).toEqual({ ...b.serverRevision, physicalPage: 4, quote: qb.quote })
    navigation.page('A', readerSourceIdentity(a), 3)
    expect(navigation.select('A', readerSourceIdentity(a), qa)).toBeNull()
    expect(navigation.selection('A')).toEqual({ ...a.serverRevision, physicalPage: 2, quote: qa.quote })
    expect(navigation.selection('B')).toEqual({ ...b.serverRevision, physicalPage: 4, quote: qb.quote })
  })

  it('uses the same A/B states for narrow tabs, chat, close/reopen and leaving Compare', () => {
    const navigation = setup(); navigation.complete(navigation.begin('A'), source('revision:a')); navigation.complete(navigation.begin('B'), source('revision:b'))
    const a = navigation.state().panes.A.location, b = navigation.state().panes.B.location
    expect(readerPaneVisible(navigation.state(), 'A', false)).toBe(true); expect(readerPaneVisible(navigation.state(), 'B', false)).toBe(true)
    expect(readerPaneVisible(navigation.state(), 'A', true)).toBe(false); expect(readerPaneVisible(navigation.state(), 'B', true)).toBe(true)
    navigation.activate('A'); expect(readerPaneVisible(navigation.state(), 'A', true)).toBe(true)
    navigation.showChat(); expect(readerPaneVisible(navigation.state(), 'A', true)).toBe(false)
    navigation.close(); navigation.show(); navigation.setCompare(false)
    expect(navigation.state().panes.A.location).toBe(a); expect(navigation.state().panes.B.location).toBe(b)
    expect(readerPaneVisible(navigation.state(), 'B', false)).toBe(false)
  })

  it('bounds ephemeral back stacks and refuses a quote/page from another source', () => {
    const navigation = setup(), a = source('revision:a')
    for (let index = 0; index < 30; index++) navigation.complete(navigation.begin('A'), source(`revision:${index}`))
    expect(navigation.state().panes.A.back).toHaveLength(24)
    expect(() => navigation.complete(navigation.begin('A'), a, { documentId: 'foreign', page: 1, quote: 'not source' })).toThrow('identity')
    expect(() => navigation.complete(navigation.begin('A'), a, { documentId: a.id, page: 99, quote: 'not page' })).toThrow('identity')
  })
})

describe('controlled PDF viewport restoration', () => {
  it('requires exact revision/hash/page and bounded viewport numbers', () => {
    const a = source('revision:a'), view = initialPdfView(a, 2)
    expect(validPdfView(view, a, 2)).toBe(true)
    expect(validPdfView(view, source('revision:b'), 2)).toBe(false)
    expect(validPdfView(view, { ...a, sha256: 'c'.repeat(64) }, 2)).toBe(false)
    expect(validPdfView(view, a, 3)).toBe(false)
    expect(validPdfView({ ...view, scrollTop: NaN }, a, 2)).toBe(false)
    expect(validPdfView({ ...view, zoom: 300 }, a, 2)).toBe(false)
  })
  it('restores the same reading fraction across width changes and never overrides a later user interaction', () => {
    const view = { ...initialPdfView(source('revision:a'), 2), scrollTop: 200, scrollHeight: 1400, viewportHeight: 600 }
    expect(restoredPdfTop(view, 1400, 600)).toBe(200)
    expect(restoredPdfTop(view, 2200, 600)).toBe(400)
    expect(restoredPdfTop(view, 300, 600)).toBe(0)
    expect(pdfRestoreIsCurrent('A:revision1:2', 'A:revision1:2', 7, 7)).toBe(true)
    expect(pdfRestoreIsCurrent('A:revision1:2', 'A:revision2:2', 7, 7)).toBe(false)
    expect(pdfRestoreIsCurrent('A:revision1:2', 'A:revision1:2', 7, 8)).toBe(false)
  })
})
