/** Ephemeral viewport state, never source/evidence authority. */
export interface PdfViewState {
  layout?: 'continuous'
  identity: string
  page: number
  zoom: number
  scrollTop: number
  scrollLeft: number
  scrollHeight: number
  viewportHeight: number
}
type SourceIdentity = { id: string, sha256: string, serverRevision?: { documentId: string, revisionId: string } }
export function pdfViewIdentity(source: SourceIdentity): string { return JSON.stringify([source.id, source.sha256, source.serverRevision?.documentId ?? null, source.serverRevision?.revisionId ?? null]) }
export function initialPdfView(source: SourceIdentity, page: number, zoom = 100): PdfViewState { return { identity: pdfViewIdentity(source), page, zoom, scrollTop: 0, scrollLeft: 0, scrollHeight: 0, viewportHeight: 0 } }
export function validPdfView(value: PdfViewState | undefined, source: SourceIdentity, page: number): value is PdfViewState {
  return value !== undefined && value.identity === pdfViewIdentity(source) && value.page === page
    && [75, 100, 125, 150, 175].includes(value.zoom) && [value.scrollTop, value.scrollLeft, value.scrollHeight, value.viewportHeight].every(item => Number.isFinite(item) && item >= 0 && item <= 10000000)
}
export function restoredPdfTop(value: PdfViewState, scrollHeight: number, viewportHeight: number): number {
  const previous = Math.max(0, value.scrollHeight - value.viewportHeight), current = Math.max(0, scrollHeight - viewportHeight)
  return Math.max(0, Math.min(current, previous ? value.scrollTop / previous * current : value.scrollTop))
}
export function pdfRestoreIsCurrent(requestedKey: string, currentKey: string, requestedInteraction: number, currentInteraction: number): boolean {
  return requestedKey === currentKey && requestedInteraction === currentInteraction
}
