import { readFileSync } from 'node:fs'

import {
  type ResearchNotebookRequest,
  type ResearchNotebookResult,
  researchNotebookRpcIssues,
} from '../src/index.ts'
import { validateContractShape } from '../src/node.ts'
import { describe, expect, it } from 'vitest'

const fixture = JSON.parse(readFileSync(
  new URL('../../../contracts/fixtures/m3/research-notebook.json', import.meta.url),
  'utf8',
)) as { request: ResearchNotebookRequest, result: ResearchNotebookResult }

describe('Research Notebook contracts', () => {
  it('accepts bounded typed working and prior-research rows', () => {
    expect(validateContractShape('research-notebook-rpc', fixture.request).ok).toBe(true)
    expect(validateContractShape('research-notebook-rpc', fixture.result).ok).toBe(true)
    expect(researchNotebookRpcIssues(fixture.result, fixture.request)).toEqual([])
  })

  it('rejects path input and reports identity, layer, use, source, filter, and count drift', () => {
    expect(validateContractShape('research-notebook-rpc', {
      ...fixture.request,
      path: '/private/investigation.sqlite3',
    }).ok).toBe(false)
    const result = structuredClone(fixture.result)
    result.workspaceId = 'workspace:other'
    result.items[0]!.layer = 'research'
    result.items[0]!.useStatus = 'unverified-lead'
    result.items[1]!.sourceState = 'current-scope'
    result.items[1]!.recordType = 'open-question'
    result.pageInfo.usedChars = 1
    expect(researchNotebookRpcIssues(result, fixture.request).map(issue => issue.code)).toEqual([
      'research-notebook-layer',
      'research-notebook-use',
      'research-notebook-source-state',
      'research-notebook-count',
      'research-notebook-identity',
      'research-notebook-filter',
    ])
  })
})
