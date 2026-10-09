import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { SidecarSupervisor, documentSupervisorOptions, type DocumentProcess } from '../src/index.js'

it('does not resurrect a process when disposed before the startup await completes', async () => {
  const spawn = vi.fn(() => { throw new Error('must not spawn') })
  const supervisor = new SidecarSupervisor(documentSupervisorOptions(spawn))
  const started = supervisor.start()
  const rejected = expect(started).rejects.toThrow('cancelled')
  await supervisor.dispose(); await rejected
  expect(spawn).not.toHaveBeenCalled()
  expect(supervisor.state).toBe('stopped')
})

it('waits for a late-spawned process to actually terminate before disposal resolves', async () => {
  const launching = Promise.withResolvers<DocumentProcess>()
  const exited = Promise.withResolvers<{ exitCode: number, signal: null }>()
  const terminate = vi.fn()
  const spawn = vi.fn(() => launching.promise)
  const supervisor = new SidecarSupervisor(documentSupervisorOptions(spawn))
  const started = supervisor.start(), rejected = expect(started).rejects.toThrow('cancelled')
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
  let done = false
  const stopping = supervisor.dispose().then(() => { done = true })
  launching.resolve({ stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), done: exited.promise,
    terminate, waitForExit: async () => { await exited.promise; return true } })
  await vi.waitFor(() => expect(terminate).toHaveBeenCalledOnce())
  expect(done).toBe(false)
  exited.resolve({ exitCode: 0, signal: null })
  await stopping; await rejected
  expect(supervisor.state).toBe('stopped')
})
