import type { ProductBinding } from './product-control-contracts.js'
export type ProductHttpValue =
  | { schemaVersion: 1, kind: 'conversation-create', idempotencyKey: string }
  | { schemaVersion: 1, kind: 'conversation-list', items: ProductBinding[], nextCursor: string | null }
  | { schemaVersion: 1, kind: 'auth-exchange', code: string }
  | { schemaVersion: 1, kind: 'bootstrap', actor: { actorId: string, workspaceId: string }, csrfToken: string }
  | { schemaVersion: 1, kind: 'api-error', code: 'unauthenticated' | 'forbidden' | 'invalid-request' | 'not-found' | 'conflict' | 'limit-exceeded' | 'unavailable' }
  | { schemaVersion: 1, kind: 'runtime-stopped', conversationId: string, generation: number }
