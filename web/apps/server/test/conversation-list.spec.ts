import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ControlStore } from '../src/storage/control-store.js'
it('paginates only the paired actor/workspace conversations and rejects foreign cursors', () => {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-conversation-list-')), store = ControlStore.open(root)
  const actor = { actorId: 'actor:list', workspaceId: 'workspace:list' }
  try {
    for (let i = 0; i < 34; i++) store.createConversation(actor, { conversationId: `conversation:${String(i).padStart(2, '0')}`, runtimeSessionId: `session:${i}` })
    store.createConversation({ ...actor, workspaceId: 'workspace:foreign' }, { conversationId: 'foreign:workspace', runtimeSessionId: 'session:foreign' })
    store.createConversation({ ...actor, actorId: 'actor:foreign' }, { conversationId: 'foreign:actor', runtimeSessionId: 'session:other' })
    const first = store.conversations(actor), second = store.conversations(actor, first.nextCursor!)
    expect(first.items).toHaveLength(32); expect(second.items).toHaveLength(2); expect(second.nextCursor).toBeNull()
    expect([...first.items, ...second.items].every(value => value.workspaceId === actor.workspaceId && value.ownerActorId === actor.actorId)).toBe(true)
    expect(() => store.conversations(actor, 'foreign:workspace')).toThrow()
    expect(() => store.conversations(actor, 'foreign:actor')).toThrow()
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})
