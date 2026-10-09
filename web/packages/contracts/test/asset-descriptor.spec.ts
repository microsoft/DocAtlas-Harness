import { describe, expect, it } from 'vitest'

import {
  assetDescriptorIssues,
  type AssetDescriptor,
  MAX_VISUAL_ASSET_BYTES,
} from '../src/index.ts'
import { validateContractShape } from '../src/node.ts'

const original: AssetDescriptor = {
  schemaVersion: 1,
  assetId: 'rep:asset:original',
  kind: 'original-bytes',
  documentId: 'doc:asset',
  revisionId: 'rev:asset:1',
  representationId: 'rep:asset:original',
  representationContentHash: 'a'.repeat(64),
  contentHash: 'a'.repeat(64),
  mediaType: 'application/pdf',
  byteLength: 1024,
  createdAt: '2026-08-30T07:00:00Z',
}

describe('AssetDescriptor', () => {
  it('accepts immutable original and bounded page image descriptors', () => {
    expect(validateContractShape('asset-descriptor', original).ok).toBe(true)
    expect(assetDescriptorIssues(original)).toEqual([])
    const page: AssetDescriptor = {
      ...original,
      assetId: 'asset:page:1',
      kind: 'page-image',
      representationId: 'rep:asset:text',
      representationContentHash: 'b'.repeat(64),
      contentHash: 'c'.repeat(64),
      mediaType: 'image/png',
      physicalPage: 1,
      width: 1200,
      height: 1600,
      generator: { name: 'pdfium', version: '1.0.0', configHash: 'd'.repeat(64) },
    }
    expect(validateContractShape('asset-descriptor', page).ok).toBe(true)
    expect(assetDescriptorIssues(page)).toEqual([])
  })

  it('rejects visual fields on originals and aggregate image overflows', () => {
    expect(assetDescriptorIssues({ ...original, physicalPage: 1 })).not.toEqual([])
    expect(assetDescriptorIssues({
      ...original,
      assetId: 'asset:large',
      kind: 'page-image',
      representationId: 'rep:text',
      representationContentHash: 'b'.repeat(64),
      contentHash: 'c'.repeat(64),
      mediaType: 'image/png',
      byteLength: MAX_VISUAL_ASSET_BYTES + 1,
      physicalPage: 1,
      width: 10_000,
      height: 10_000,
      generator: { name: 'pdfium', version: '1', configHash: 'd'.repeat(64) },
    }).map(issue => issue.code)).toEqual(['asset-pixel-limit', 'asset-byte-limit'])
  })
})
