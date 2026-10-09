import type { ProductSelectionProposal } from '@docatlas/contracts'
import type { PdfQuote, PdfReaderSource } from '../PdfReader'
import { initialPdfView, pdfViewIdentity, validPdfView, type PdfViewState } from '../pdf-view-state'

export type ReaderPane = 'A' | 'B'
export interface AnswerReturn { messageId: string, scrollTop: number }
export interface ReaderLocation { source: PdfReaderSource, page: number, focus: PdfQuote | null, selection: PdfQuote | null, view: PdfViewState, answer: AnswerReturn | null }
export interface PaneState { location: ReaderLocation | null, back: ReaderLocation[], pending: number | null, navigation: number, restore: 'position' | 'focus' }
export interface ReaderState { scope: string, visible: boolean, compare: boolean, active: ReaderPane, surface: 'chat' | 'reader', serial: number, panes: Record<ReaderPane, PaneState> }
export interface ReaderIntent { scope: string, pane: ReaderPane, serial: number }
const emptyPane = (): PaneState => ({ location: null, back: [], pending: null, navigation: 0, restore: 'position' })
export const emptyReaderState = (scope = ''): ReaderState => ({ scope, visible: false, compare: false, active: 'A', surface: 'reader', serial: 0, panes: { A: emptyPane(), B: emptyPane() } })
export const readerSourceIdentity = (source: PdfReaderSource): string => pdfViewIdentity(source)
const matchesQuote = (location: ReaderLocation, quote: PdfQuote): boolean => quote.documentId === location.source.id && quote.page === location.page && !!quote.quote.trim() && quote.quote.length <= 2000

/** Two independent, bounded user cursors. Does not hold Agent scope or durable research state. */
export class ReaderNavigation {
  private value = emptyReaderState()
  private shell = this.value
  private readonly listeners = new Set<() => void>()
  readonly state = (): ReaderState => this.value
  /** Chat layout does not depend on per-frame PDF viewport offsets. */
  readonly shellState = (): ReaderState => this.shell
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private set(value: ReaderState, shell = true): void { this.value = value; if (shell) this.shell = value; for (const listener of this.listeners) listener() }
  reset(scope: string): void { if (scope !== this.value.scope) this.set({ ...emptyReaderState(scope), serial: this.value.serial + 1 }) }
  begin(pane = this.value.active): ReaderIntent {
    const serial = this.value.serial + 1
    this.set({ ...this.value, serial, active: pane, panes: { ...this.value.panes, [pane]: { ...this.value.panes[pane], pending: serial } } })
    return { scope: this.value.scope, pane, serial }
  }
  complete(intent: ReaderIntent, source: PdfReaderSource, focus: PdfQuote | null = null, answer: AnswerReturn | null = null): boolean {
    const pane = this.value.panes[intent.pane]
    if (intent.scope !== this.value.scope || pane.pending !== intent.serial) return false
    const revision = source.serverRevision, page = focus?.page ?? 1
    if (source.kind !== 'server' || !revision || !Number.isSafeInteger(page) || page < 1 || source.pages !== null && page > source.pages || focus && focus.documentId !== source.id) throw new Error('Reader target identity is invalid')
    const zoom = pane.location?.view.zoom ?? 100
    const location: ReaderLocation = { source: structuredClone(source), page, focus: focus && structuredClone(focus), selection: null, view: initialPdfView(source, page, zoom), answer: answer && { ...answer } }
    const back = pane.location ? [...pane.back, structuredClone(pane.location)].slice(-24) : pane.back
    this.set({ ...this.value, visible: true, compare: this.value.compare || intent.pane === 'B', surface: this.value.active === intent.pane ? 'reader' : this.value.surface,
      panes: { ...this.value.panes, [intent.pane]: { location, back, pending: null, navigation: intent.serial, restore: focus ? 'focus' : 'position' } } })
    return true
  }
  reject(intent: ReaderIntent): void { if (intent.scope === this.value.scope && this.value.panes[intent.pane].pending === intent.serial) this.set({ ...this.value, panes: { ...this.value.panes, [intent.pane]: { ...this.value.panes[intent.pane], pending: null } } }) }
  activate(pane: ReaderPane): void {
    if (this.value.active === pane && this.value.surface === 'reader') return
    this.set({ ...this.value, serial: this.value.serial + 1, active: pane, surface: 'reader', panes: { A: { ...this.value.panes.A, pending: null }, B: { ...this.value.panes.B, pending: null } } })
  }
  interact(pane: ReaderPane): void {
    this.activate(pane)
    this.set({ ...this.value, serial: this.value.serial + 1, panes: { ...this.value.panes, [pane]: { ...this.value.panes[pane], pending: null } } })
  }
  show(compare = this.value.compare): void { this.set({ ...this.value, visible: true, compare, surface: 'reader' }) }
  setCompare(compare: boolean): void { if (compare === this.value.compare) return; this.set({ ...this.value, compare, active: compare ? this.value.active : 'A', surface: 'reader', panes: { A: { ...this.value.panes.A, pending: null }, B: { ...this.value.panes.B, pending: null } } }) }
  showChat(): void { this.set({ ...this.value, surface: 'chat', serial: this.value.serial + 1, panes: { A: { ...this.value.panes.A, pending: null }, B: { ...this.value.panes.B, pending: null } } }) }
  close(): void { this.showChat(); this.set({ ...this.value, visible: false }) }
  page(paneId: ReaderPane, identity: string, page: number): void {
    const pane = this.value.panes[paneId], location = pane.location
    if (!location || readerSourceIdentity(location.source) !== identity || !Number.isSafeInteger(page) || page < 1 || location.source.pages !== null && page > location.source.pages) return
    this.interact(paneId)
    const serial = this.value.serial + 1
    this.set({ ...this.value, serial, panes: { ...this.value.panes, [paneId]: { ...pane, pending: null, navigation: serial, restore: 'position', location: { ...location, page, focus: null, view: initialPdfView(location.source, page, location.view.zoom) } } } })
  }
  pages(paneId: ReaderPane, identity: string, pages: number): void {
    const pane = this.value.panes[paneId], location = pane.location
    if (!location || readerSourceIdentity(location.source) !== identity || !Number.isSafeInteger(pages) || pages < 1 || location.source.pages === pages) return
    this.set({ ...this.value, panes: { ...this.value.panes, [paneId]: { ...pane, location: { ...location, source: { ...location.source, pages } } } } })
  }
  /** Scrolling changes the visible cursor, not navigation history or native source scope. */
  visiblePage(paneId: ReaderPane, identity: string, page: number): void {
    const pane = this.value.panes[paneId], location = pane.location
    if (!location || readerSourceIdentity(location.source) !== identity || location.page === page || !Number.isSafeInteger(page)
      || page < 1 || page > (location.source.pages ?? 10000)) return
    this.set({ ...this.value, panes: { ...this.value.panes, [paneId]: { ...pane, location: { ...location, page,
      view: { ...location.view, page, layout: 'continuous' } } } } })
  }
  view(paneId: ReaderPane, view: PdfViewState): void {
    const pane = this.value.panes[paneId], location = pane.location
    if (!location || !validPdfView(view, location.source, location.page) || JSON.stringify(location.view) === JSON.stringify(view)) return
    this.set({ ...this.value, panes: { ...this.value.panes, [paneId]: { ...pane, location: { ...location, view: { ...view } } } } }, false)
  }
  select(paneId: ReaderPane, identity: string, quote: PdfQuote): ProductSelectionProposal | null {
    const pane = this.value.panes[paneId], location = pane.location
    if (!location?.source.serverRevision || readerSourceIdentity(location.source) !== identity || !matchesQuote(location, quote)) return null
    this.interact(paneId)
    this.set({ ...this.value, panes: { ...this.value.panes, [paneId]: { ...this.value.panes[paneId], location: { ...location, selection: { ...quote } } } } })
    return { ...location.source.serverRevision, physicalPage: quote.page, quote: quote.quote }
  }
  selection(paneId: ReaderPane): ProductSelectionProposal | null {
    const location = this.value.panes[paneId].location, quote = location?.selection
    return location?.source.serverRevision && quote && quote.documentId === location.source.id ? { ...location.source.serverRevision, physicalPage: quote.page, quote: quote.quote } : null
  }
  back(paneId: ReaderPane): void {
    const pane = this.value.panes[paneId], previous = pane.back.at(-1)
    if (!previous) return
    const serial = this.value.serial + 1
    this.set({ ...this.value, serial, active: paneId, surface: 'reader', panes: { ...this.value.panes, [paneId]: { location: structuredClone(previous), back: pane.back.slice(0, -1), pending: null, navigation: serial, restore: 'position' } } })
  }
}
