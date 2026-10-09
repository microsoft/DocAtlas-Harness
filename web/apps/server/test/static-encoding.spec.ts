import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { encodeStaticAsset, staticAssetCacheControl, staticEncoding } from '../src/http/static-encoding.js'

describe('bounded immutable code/style transfer encoding', () => {
  const bytes = Buffer.from('export const documentation = "source";\n'.repeat(400)), asset = encodeStaticAsset(bytes, 'text/javascript')
  it('precompresses exactly the same bytes for both supported encodings', () => {
    expect(brotliDecompressSync(asset.br!)).toEqual(bytes); expect(gunzipSync(asset.gzip!)).toEqual(bytes)
    expect(asset.br!.length).toBeLessThan(bytes.length / 10)
    expect(staticEncoding(asset, 'gzip, br').encoding).toBe('br')
  })
  it('honors quality, explicit refusals, casing and identity fallback', () => {
    expect(staticEncoding(asset, 'br;q=0, gzip;q=1').encoding).toBe('gzip')
    expect(staticEncoding(asset, 'BR;q=0.3, GZIP;q=0.9').encoding).toBe('gzip')
    expect(staticEncoding(asset, '*;q=1, br;q=0').encoding).toBe('gzip')
    for (const accept of [undefined, '', 'br;q=0, gzip;q=0', 'br;q=invalid', 'deflate']) expect(staticEncoding(asset, accept)).toEqual({ bytes })
  })
  it('never precompresses PDF, JSON, fonts or small resources', () => {
    for (const type of ['application/pdf', 'application/json', 'font/woff2']) expect(encodeStaticAsset(bytes, type)).toEqual({ bytes, type })
    expect(encodeStaticAsset(Buffer.from('small'), 'text/css')).not.toHaveProperty('br')
  })
  it('caches only fixed content-fingerprinted code/style/font paths, never user data or entry HTML', () => {
    for (const path of ['/assets/live-AbCd1234.js', '/assets/DocumentMap-Bcd-34_f.css', '/assets/font-Abcd1234.woff2']) expect(staticAssetCacheControl(path)).toContain('immutable')
    for (const path of ['/', '/live.html', '/api/submissions', '/api/conversations/x/documents/y/z/original', '/assets/main.js', '/assets/live-AbCd1234.pdf', '/assets/live-AbCd1234.js?x=1', '/assets/../live-AbCd1234.js']) expect(staticAssetCacheControl(path)).toBe('no-store')
  })
})
