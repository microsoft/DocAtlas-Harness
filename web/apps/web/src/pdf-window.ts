/** Bounded continuous-page layout, independent of PDF parsing and source authority. */
export interface PdfSlot { page: number, top: number, height: number, width: number }
export function pdfSlots(count: number, width: number, zoom: number, ratios: ReadonlyMap<number, number>): PdfSlot[] {
  let top = 0
  const fitted = Math.max(160, Math.min(width, 880)) * zoom / 100
  return Array.from({ length: Math.min(10000, Math.max(0, count)) }, (_, index) => {
    const page = index + 1, ratio = ratios.get(page) ?? ratios.get(1) ?? 792 / 612
    const slot = { page, top, height: fitted * ratio, width: fitted }; top += slot.height + 24
    return slot
  })
}
export function pageAt(slots: readonly PdfSlot[], top: number): number {
  let low = 0, high = slots.length - 1
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (slots[mid]!.top <= top) low = mid; else high = mid - 1 }
  return slots[low]?.page ?? 1
}
export function windowPages(slots: readonly PdfSlot[], top: number, viewport: number): PdfSlot[] {
  const first = Math.max(1, pageAt(slots, top) - 1), last = Math.min(slots.length, pageAt(slots, top + viewport) + 1)
  return slots.slice(first - 1, Math.min(last, first + 4))
}
