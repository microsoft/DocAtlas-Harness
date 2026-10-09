/** Shared by host pagination and native tool presentation. Count the serialized
 * envelope, not just preview text; UTF-16 length and UTF-8 bytes have separate caps. */
export function fitsDocumentPresentation(text: string): boolean {
  return text.length <= 30000 && Buffer.byteLength(text, 'utf8') <= 65536
}
