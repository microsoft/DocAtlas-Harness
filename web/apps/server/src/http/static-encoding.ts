import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

export interface StaticAsset { bytes: Buffer, type: string, br?: Buffer, gzip?: Buffer }
/** Only content-fingerprinted public build assets. HTML, PDF and API data remain no-store. */
export function staticAssetCacheControl(path: string): string {
  return /^\/assets\/[A-Za-z0-9._-]+-[A-Za-z0-9_-]{8,}\.(?:js|mjs|css|woff2)$/.test(path) ? 'public, max-age=31536000, immutable' : 'no-store'
}
/** Only immutable public application code/styles, never authenticated documents or API bodies. */
export function encodeStaticAsset(bytes: Buffer, type: string): StaticAsset {
  if (bytes.length < 2048 || !['text/javascript', 'text/css'].includes(type)) return { bytes, type }
  return { bytes, type, br: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }), gzip: gzipSync(bytes, { level: 6 }) }
}
export function staticEncoding(asset: StaticAsset, accept: string | undefined): { bytes: Buffer, encoding?: 'br' | 'gzip' } {
  const qualities = new Map<string, number>()
  for (const part of (accept ?? '').toLowerCase().split(',')) {
    const [name, ...parameters] = part.trim().split(';'), q = parameters.map(item => item.trim()).find(item => item.startsWith('q='))
    qualities.set(name!, q === undefined ? 1 : /^q=(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(q) ? Number(q.slice(2)) : 0)
  }
  const supported = (['br', 'gzip'] as const).map(encoding => ({ encoding, q: qualities.get(encoding) ?? qualities.get('*') ?? 0 }))
    .filter(item => item.q > 0 && asset[item.encoding]).sort((a, b) => b.q - a.q)
  const encoding = supported[0]?.encoding
  return encoding ? { bytes: asset[encoding]!, encoding } : { bytes: asset.bytes }
}
