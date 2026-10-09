import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { afterEach, expect, it } from 'vitest'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })

// Capability experiment, not a claim that the product's complete Pi/storage/
// provider boundary is implemented. The production launcher must fail closed.
it.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/bwrap'))('OS boundary: workspace RW, sources RO, private state/env/network inaccessible', async () => {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-boundary-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace'), sources = join(root, 'sources'), privatePath = join(root, 'private-canary')
  mkdirSync(workspace); mkdirSync(sources)
  writeFileSync(join(workspace, 'input.txt'), 'workspace input')
  writeFileSync(join(sources, 'source.txt'), 'immutable source')
  writeFileSync(privatePath, 'NOT_FOR_NATIVE_TOOLS')
  const server = createServer(socket => socket.end('host-only'))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing host listener')
  const code = `
    const fs = require('node:fs'); const net = require('node:net');
    const result = { input: fs.readFileSync('/workspace/input.txt', 'utf8'), privateVisible: fs.existsSync(${JSON.stringify(privatePath)}),
      homeVisible: fs.existsSync('/home/azureuser'), cleanEnvironment: Object.keys(process.env).every(k => k === 'PATH' || k === 'PWD') && process.env.PWD === '/workspace' };
    fs.writeFileSync('/workspace/output.txt', 'native output');
    try { fs.writeFileSync('/sources/source.txt', 'tamper'); result.sourceReadOnly = false; }
    catch (error) { result.sourceReadOnly = error.code === 'EROFS' || error.code === 'EACCES'; }
    const socket = net.connect(${address.port}, '127.0.0.1');
    socket.setTimeout(1500);
    socket.once('connect', () => { result.hostNetworkBlocked = false; socket.destroy(); });
    socket.once('error', () => { result.hostNetworkBlocked = true; });
    socket.once('timeout', () => { result.hostNetworkBlocked = true; socket.destroy(); });
    socket.once('close', () => console.log(JSON.stringify(result)));
  `
  const args = ['--unshare-user', '--unshare-pid', '--unshare-net', '--die-with-parent', '--new-session',
    '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/runtime', '--ro-bind', process.execPath, '/runtime/node',
    '--bind', workspace, '/workspace', '--ro-bind', sources, '/sources', '--chdir', '/workspace', '--', '/runtime/node', '-e', code]
  const result = await new Promise<{ code: number | null, stdout: string, stderr: string }>((resolve, reject) => {
    const child = spawn('/usr/bin/bwrap', args, { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
  expect(result.code, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ input: 'workspace input', privateVisible: false, homeVisible: false,
    cleanEnvironment: true, sourceReadOnly: true, hostNetworkBlocked: true })
  expect(readFileSync(join(workspace, 'output.txt'), 'utf8')).toBe('native output')
  expect(readFileSync(join(sources, 'source.txt'), 'utf8')).toBe('immutable source')
}, 10_000)
