import type { ContractIssue, ContractIssueCode, OpaqueId, Sha256 } from './m0-contracts.js'

export const MAX_VISUAL_ASSET_PIXELS = 40_000_000
export const MAX_VISUAL_ASSET_BYTES = 32 * 1024 * 1024

export interface AssetDescriptor {
  schemaVersion: 1
  assetId: OpaqueId
  kind: 'original-bytes' | 'page-image' | 'figure-crop'
  documentId: OpaqueId
  revisionId: OpaqueId
  representationId: OpaqueId
  representationContentHash: Sha256
  contentHash: Sha256
  mediaType: 'application/pdf' | 'text/markdown' | 'text/plain' | 'image/png' | 'image/jpeg'
  byteLength: number
  physicalPage?: number
  width?: number
  height?: number
  figureId?: OpaqueId
  generator?: {
    name: string
    version: string
    configHash: Sha256
  }
  createdAt: string
}

export function assetDescriptorIssues(value: AssetDescriptor): ContractIssue[] {
  const issues: ContractIssue[] = []
  const issue = (code: ContractIssueCode, path: string, message: string): void => {
    issues.push({ code, path, message })
  }
  if (value.kind === 'original-bytes') {
    if (value.contentHash !== value.representationContentHash) {
      issue('asset-original-hash-mismatch', '/contentHash', 'original asset hashes must match')
    }
    if (value.physicalPage !== undefined || value.width !== undefined || value.height !== undefined
      || value.figureId !== undefined || value.generator !== undefined) {
      issue('asset-original-visual-fields', '/', 'original asset cannot carry visual fields')
    }
    return issues
  }
  if (value.width !== undefined && value.height !== undefined
    && value.width * value.height > MAX_VISUAL_ASSET_PIXELS) {
    issue('asset-pixel-limit', '/width', 'visual asset exceeds the aggregate pixel limit')
  }
  if (value.byteLength > MAX_VISUAL_ASSET_BYTES) {
    issue('asset-byte-limit', '/byteLength', 'visual asset exceeds the byte limit')
  }
  if (value.kind === 'page-image' && value.figureId !== undefined) {
    issue('asset-page-has-figure', '/figureId', 'page image cannot carry a figure id')
  }
  return issues
}
