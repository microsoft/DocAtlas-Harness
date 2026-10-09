import { readFileSync } from 'node:fs'

import type { ProtocolError, SourceScopeCommitResult } from '../src/index.ts'
import { describe, expect, it } from 'vitest'

import { validateContractShape } from '../src/node.ts'

const fixture = JSON.parse(readFileSync(
  new URL('../../../contracts/fixtures/m2/source-scope.json', import.meta.url),
  'utf8',
)) as { commitResult: SourceScopeCommitResult, commitRequest: unknown }

describe('authenticated browser RPC envelope', () => {
  it('accepts versioned domain success and failure without weakening transport errors', () => {
    expect(validateContractShape('browser-rpc', {
      schemaVersion: 1,
      ok: true,
      result: fixture.commitResult,
    }).ok).toBe(true)
    const error: ProtocolError = {
      schemaVersion: 1,
      code: 'conflict',
      message: 'scope changed',
      retryable: false,
      nextActions: ['retry'],
    }
    expect(validateContractShape('browser-rpc', {
      schemaVersion: 1,
      ok: false,
      error,
    }).ok).toBe(true)
  })

  it('does not accept a request or mixed success/error fields as a result', () => {
    expect(validateContractShape('browser-rpc', {
      schemaVersion: 1,
      ok: true,
      result: fixture.commitRequest,
    }).ok).toBe(false)
    expect(validateContractShape('browser-rpc', {
      schemaVersion: 1,
      ok: true,
      result: fixture.commitResult,
      error: { schemaVersion: 1, code: 'internal', message: 'mixed', retryable: true },
    }).ok).toBe(false)
  })
})
