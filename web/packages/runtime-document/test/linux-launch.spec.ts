import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { documentLaunch } from '../src/linux-launch.js'
import { launchUvDocumentProcess } from '../src/node-process.js'

const temporary: string[] = []
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-document-namespace-')); temporary.push(root)
  const input = join(root, 'sources'), privateRoot = join(root, 'private'), cacheRoot = join(root, 'cache')
  mkdirSync(input); mkdirSync(privateRoot)
  writeFileSync(join(input, 'approved.txt'), 'APPROVED_SOURCE')
  writeFileSync(join(privateRoot, 'secret'), 'PRIVATE_CANARY')
  return { input, privateRoot, cacheRoot, projectRoot: resolve('python/docatlas-sidecar') }
}
describe.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/bwrap'))('whole document process namespace', () => {
  it.each(['docatlas-sidecar', 'docatlas-tree'] as const)('joins %s when cancelled immediately after spawning', async command => {
    const value = fixture()
    const child = await launchUvDocumentProcess({ ...value, sourceRoots: {} }, command)
    child.stdout!.resume(); child.stderr!.resume()
    child.terminate()
    expect(await child.waitForExit()).toBe(true)
    expect(await child.done).toHaveProperty('signal')
  }, 15000)
  it('hides private state/environment, makes sources/runtime read-only, and permits only cache publication', async () => {
    const value = fixture()
    const previous = process.env.DOCATLAS_NAMESPACE_CANARY
    process.env.DOCATLAS_NAMESPACE_CANARY = 'DO_NOT_FORWARD'
    const launch = await documentLaunch({ ...value, sourceRoots: { 'root:docs': value.input }, protectedRoots: [value.privateRoot] }, 'docatlas-sidecar')
    if (previous === undefined) delete process.env.DOCATLAS_NAMESPACE_CANARY; else process.env.DOCATLAS_NAMESPACE_CANARY = previous
    const index = launch.args.indexOf('-c')
    launch.args[index + 1] = `import os,json,socket,pathlib
source=pathlib.Path('/input/source-0/approved.txt')
assert os.statvfs(${JSON.stringify(join(value.projectRoot, 'src'))}).f_flag & os.ST_RDONLY
def writable(path):
 try:
  with open(path,'ab') as stream: stream.write(b'x')
  return True
 except OSError: return False
network=socket.socket();network.settimeout(0.1)
try:
 network.connect(('1.1.1.1',443));connected=True
except OSError: connected=False
pathlib.Path('/data/cache/result').write_text('owned-cache')
print(json.dumps({'source':source.read_text(),'sourceWritable':writable(str(source)),'privateVisible':pathlib.Path(${JSON.stringify(join(value.privateRoot, 'secret'))}).exists(),'hostPidVisible':pathlib.Path('/proc/${process.pid}/cmdline').exists(),'network':connected,'secretEnv':'DOCATLAS_NAMESPACE_CANARY' in os.environ}))`
    expect(launch.env).not.toHaveProperty('DOCATLAS_NAMESPACE_CANARY')
    const result = JSON.parse(execFileSync(launch.command, launch.args, { env: launch.env, encoding: 'utf8', timeout: 10000 }))
    expect(result).toEqual({ source: 'APPROVED_SOURCE', sourceWritable: false, privateVisible: false, hostPidVisible: false, network: false, secretEnv: false })
    expect(readFileSync(join(value.cacheRoot, 'result'), 'utf8')).toBe('owned-cache')
    expect(readFileSync(join(value.input, 'approved.txt'), 'utf8')).toBe('APPROVED_SOURCE')
  })
  it('rejects source/cache grants overlapping private state before spawning', async () => {
    const value = fixture()
    await expect(documentLaunch({ ...value, sourceRoots: { root: value.privateRoot }, protectedRoots: [value.privateRoot] }, 'docatlas-sidecar')).rejects.toThrow('protected')
    await expect(documentLaunch({ ...value, cacheRoot: value.privateRoot, sourceRoots: {}, protectedRoots: [value.privateRoot] }, 'docatlas-sidecar')).rejects.toThrow('protected')
    await expect(documentLaunch({ ...value, sourceRoots: { root: dirnameFor(value.input) }, protectedRoots: [value.privateRoot] }, 'docatlas-sidecar')).rejects.toThrow()
  })
})
function dirnameFor(path: string): string { return resolve(path, '..') }
