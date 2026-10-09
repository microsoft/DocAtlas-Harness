export const DOCATLAS_ASSET_PATH = '/api/docatlas.asset'
const OPAQUE_ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

/** Build the only browser-visible DocAtlas binary URL from an opaque asset identity. */
export function docAtlasAssetUrl(assetId: string, sessionId: string): string {
  if (!OPAQUE_ASSET_ID.test(assetId)) throw new TypeError('invalid DocAtlas asset id')
  if (!OPAQUE_ASSET_ID.test(sessionId)) throw new TypeError('invalid DocAtlas session id')
  return `${DOCATLAS_ASSET_PATH}?assetId=${encodeURIComponent(assetId)}&sessionId=${encodeURIComponent(sessionId)}`
}
