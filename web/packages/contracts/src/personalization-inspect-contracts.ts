import type { MemorySessionPolicy, MemoryUse, MemoryVersion, PersonalizationDecision } from './personalization-contracts.js'

export interface PersonalizationInspectRequest {
  schemaVersion: 1
  requestType: 'personalization-inspect'
  profileId: string
  sessionId: string
  maxItems: number
}

export interface PersonalizationInspectResult {
  schemaVersion: 1
  resultType: 'personalization-inspection'
  profileId: string
  sessionId: string
  profileRevision: number
  sessionPolicy?: MemorySessionPolicy
  memories: MemoryVersion[]
  decisions: PersonalizationDecision[]
  uses: MemoryUse[]
  counts: {
    memories: number
    decisions: number
    uses: number
  }
  truncated: {
    memories: boolean
    decisions: boolean
    uses: boolean
  }
}

export type PersonalizationInspectValue = PersonalizationInspectRequest | PersonalizationInspectResult

export interface PersonalizationInspectIssue {
  code: 'identity' | 'count' | 'truncation'
  path: string
  message: string
}

export function personalizationInspectIssues(
  value: PersonalizationInspectValue,
  request?: PersonalizationInspectRequest,
): PersonalizationInspectIssue[] {
  const issues: PersonalizationInspectIssue[] = []
  const add = (code: PersonalizationInspectIssue['code'], path: string, message: string): void => {
    issues.push({ code, path, message })
  }
  if (!('resultType' in value)) return issues
  if (request !== undefined && (
    value.profileId !== request.profileId
    || value.sessionId !== request.sessionId
    || value.memories.length > request.maxItems
    || value.decisions.length > request.maxItems
    || value.uses.length > request.maxItems
  )) {
    add('identity', '/', 'personalization inspection must match the authenticated request and bounds')
  }
  if (value.sessionPolicy !== undefined && (
    value.sessionPolicy.profileId !== value.profileId
    || value.sessionPolicy.sessionId !== value.sessionId
  )) {
    add('identity', '/sessionPolicy', 'session policy belongs to another profile or Session')
  }
  for (const [index, memory] of value.memories.entries()) {
    if (memory.profileId !== value.profileId) {
      add('identity', `/memories/${index}`, 'memory belongs to another profile')
    }
  }
  for (const [index, decision] of value.decisions.entries()) {
    if (decision.profileId !== value.profileId || decision.appliesTo.sessionId !== value.sessionId) {
      add('identity', `/decisions/${index}`, 'decision belongs to another profile or Session')
    }
  }
  for (const [index, use] of value.uses.entries()) {
    if (use.profileId !== value.profileId || use.sessionId !== value.sessionId) {
      add('identity', `/uses/${index}`, 'memory use belongs to another profile or Session')
    }
  }
  for (const key of ['memories', 'decisions', 'uses'] as const) {
    if (value.counts[key] < value[key].length) {
      add('count', `/counts/${key}`, 'inspection total cannot be smaller than returned items')
    }
    if (value.truncated[key] !== (value.counts[key] > value[key].length)) {
      add('truncation', `/truncated/${key}`, 'truncation must truthfully reflect the collection total')
    }
  }
  return issues
}
