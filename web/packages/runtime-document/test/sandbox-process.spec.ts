import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SandboxProcess, sandboxProcessStart } from '../src/sandbox-process.js'

afterEach(() => vi.restoreAllMocks())
it('keeps the trusted reaper alive after the grace timer while its known namespace still exists', async () => {
  vi.useFakeTimers()
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
  const info = new PassThrough(), child = Object.assign(new EventEmitter(), { pid: process.ppid, stdio: [null, null, null, info], kill: vi.fn(() => true) })
  const guard = new SandboxProcess(child as unknown as ChildProcess)
  try {
    info.end(JSON.stringify({ 'child-pid': process.pid }))
    await guard.identified
    guard.stop(); await vi.advanceTimersByTimeAsync(800)
    expect(kill.mock.calls.length).toBeGreaterThan(1)
    expect(kill.mock.calls.every(([pid]) => pid === process.pid)).toBe(true)
  } finally {
    // The fake namespace is this test process; never signal or wait for that process in teardown.
    Reflect.set(guard, 'identity', undefined); child.emit('close', 0, null); await guard.done; vi.useRealTimers()
  }
})
it.each([Buffer.alloc(0), Buffer.from([255]), Buffer.from('{"child-pid":true}'), Buffer.alloc(8193, 32), Buffer.from(JSON.stringify({ 'child-pid': process.pid }))])('rejects malformed or foreign namespace metadata %#', async data => {
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
  const info = new PassThrough(), child = Object.assign(new EventEmitter(), { pid: 2_147_483_647, stdio: [null, null, null, info], kill: vi.fn(() => true) })
  const guard = new SandboxProcess(child as unknown as ChildProcess)
  info.end(data)
  await guard.identified
  expect(guard.failure).toBeDefined()
  expect(kill.mock.calls.every(([pid]) => pid === -child.pid)).toBe(true)
  child.emit('close', 1, null)
  await guard.done
})
describe.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/bwrap'))('real sandbox process lifetime', () => {
  it.each([0, 1, 10, 100])('stops during bootstrap at %d ms and joins the actual namespace', async milliseconds => {
    const args = ['--info-fd', '3', '--unshare-user', '--unshare-pid', '--unshare-net', '--new-session', '--die-with-parent',
      ...['/usr', '/bin', '/lib', '/lib64'].flatMap(path => ['--ro-bind', path, path]), '--ro-bind', process.execPath, '/node', '--proc', '/proc', '--dev', '/dev', '--', '/node', '-e', 'setInterval(()=>{},60000)']
    const child = spawn('/usr/bin/bwrap', args, { env: { PATH: '/bin:/usr/bin' }, stdio: ['ignore', 'pipe', 'pipe', 'pipe'], detached: true })
    const guard = new SandboxProcess(child)
    child.stdout!.resume(); child.stderr!.resume()
    const timer = milliseconds ? setTimeout(() => guard.stop(), milliseconds) : undefined
    if (!milliseconds) guard.stop()
    try {
      const identity = await guard.identified
      expect(identity).toBeDefined()
      await guard.done
      expect(guard.failure).toBeUndefined()
      let current: string | undefined
      try { current = sandboxProcessStart(identity!.pid) } catch (error) { expect((error as NodeJS.ErrnoException).code).toBe('ENOENT') }
      expect(current).not.toBe(identity!.start)
    } finally { clearTimeout(timer); guard.stop(); await guard.done }
  }, 10000)
})
