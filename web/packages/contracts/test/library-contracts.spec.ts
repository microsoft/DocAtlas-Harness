import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  type LibraryDocument,
  type LibraryDiscoverRequest,
  type LibraryDiscoverResult,
  libraryDocumentIssues,
  type LibraryJobResult,
  type LibraryRpcRequest,
  type LibraryRpcResult,
  libraryRpcIssues,
} from '../src/index.ts'
import { validateContractShape } from '../src/node.ts'

interface Fixture {
  document: LibraryDocument
  discoverRequest: LibraryDiscoverRequest
  discoverResult: LibraryDiscoverResult
  jobResult: LibraryJobResult
}

const fixture = JSON.parse(readFileSync(
  new URL('../../../contracts/fixtures/m2/library.json', import.meta.url),
  'utf8',
)) as Fixture

describe('workspace Library contracts', () => {
  it('accepts a complete no-path document and browser lifecycle', () => {
    expect(validateContractShape('library-document', fixture.document).ok).toBe(true)
    expect(libraryDocumentIssues(fixture.document)).toEqual([])
    const values: Array<LibraryRpcRequest | LibraryRpcResult> = [
      fixture.discoverRequest,
      fixture.discoverResult,
      {
        schemaVersion: 1,
        requestType: 'library-import',
        sessionId: 'session:library',
        workspaceId: 'workspace:library',
        candidateId: 'candidate:library:report',
        sourceRole: 'primary',
        idempotencyKey: 'idempotency:library:report',
      },
      {
        schemaVersion: 1,
        resultType: 'library-import-accepted',
        workspaceId: 'workspace:library',
        jobId: 'job:library:report',
        status: 'queued',
      },
      fixture.jobResult,
      {
        schemaVersion: 1,
        requestType: 'library-list',
        sessionId: 'session:library',
        workspaceId: 'workspace:library',
        limit: 20,
        sort: 'updated-desc',
      },
      {
        schemaVersion: 1,
        resultType: 'library-document',
        workspaceId: 'workspace:library',
        document: fixture.document,
      },
    ]
    for (const value of values) {
      expect(validateContractShape('library-rpc', value).ok).toBe(true)
      expect(libraryRpcIssues(value)).toEqual([])
    }
  })

  it('rejects browser paths and detects lineage/capability/active identity drift', () => {
    expect(validateContractShape('library-rpc', {
      schemaVersion: 1,
      requestType: 'library-import',
      sessionId: 'session:library',
      workspaceId: 'workspace:library',
      candidateId: 'candidate:library:report',
      sourceRole: 'primary',
      idempotencyKey: 'idempotency:library:report',
      path: '/private/report.pdf',
    }).ok).toBe(false)
    const document = structuredClone(fixture.document)
    document.activeRepresentationId = 'rep:missing'
    document.capabilities = ['original']
    document.representations[1]!.derivedFromRepresentationIds = ['rep:missing']
    expect(libraryDocumentIssues(document).map(issue => issue.code)).toEqual([
      'library-representation-lineage',
      'library-active-representation',
      'library-capability-mismatch',
    ])
  })

  it('detects invalid job phase and candidate expiry', () => {
    const job = { ...fixture.jobResult, phase: 'hashing' as const }
    expect(libraryRpcIssues(job).map(issue => issue.code)).toEqual(['library-job-phase'])
    const candidates = structuredClone(fixture.discoverResult)
    candidates.candidates[0]!.expiresAt = candidates.candidates[0]!.observedAt
    expect(libraryRpcIssues(candidates).map(issue => issue.code)).toEqual([
      'library-candidate-expiry',
    ])
  })
})
