import { describe, expect, it } from 'vitest'

import type { DocAtlasToolMetaV1 } from '../src/tool-contracts.ts'
import { validateContractShape } from '../src/node.ts'

describe('DocAtlas tool meta contract', () => {
  it('accepts one bounded standard tool/result presentation payload', () => {
    const value: DocAtlasToolMetaV1 = {
      schemaVersion: 1,
      schema: 'docatlas.tool-meta.v1',
      operation: 'search',
      scopeVersionId: 'scope:test:1',
      documentIds: ['doc:test'],
      candidateIds: ['candidate:test'],
      uiSummary: '1 candidate in 1 document',
      truncated: false,
    }
    expect(validateContractShape('docatlas-tool-meta', value)).toEqual({ ok: true, value })
  })

  it('rejects unbounded or unknown durable fields', () => {
    expect(validateContractShape('docatlas-tool-meta', {
      schemaVersion: 1,
      schema: 'docatlas.tool-meta.v1',
      operation: 'read',
      scopeVersionId: 'scope:test:1',
      documentIds: [],
      uiSummary: 'read',
      truncated: false,
      rawMarkdown: 'must not enter the session log',
    }).ok).toBe(false)
  })
})
