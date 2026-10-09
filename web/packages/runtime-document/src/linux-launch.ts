import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { accessSync, constants, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface DocumentLaunchConfiguration {
  projectRoot: string
  cacheRoot: string
  sourceRoots: Readonly<Record<string, string>>
  protectedRoots?: readonly string[]
  uvCommand?: string
}
interface RuntimeProfile { executable: string, prefix: string, basePrefix: string, codeRoot: string, version: string }
const profiles = new Map<string, RuntimeProfile>()
const execute = promisify(execFile)
const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', UV_OFFLINE: '1', PYTHONUNBUFFERED: '1' }

export function executablePath(command: string): string {
  if (isAbsolute(command)) { accessSync(command, constants.X_OK); return realpathSync(command) }
  if (!/^[A-Za-z0-9_-]+$/.test(command)) throw new Error('Executable must be an absolute path or a command name')
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(directory)) continue
    try { const candidate = join(directory, command); accessSync(candidate, constants.X_OK); if (statSync(candidate).isFile()) return realpathSync(candidate) } catch { /* Continue through trusted startup PATH. */ }
  }
  throw new Error('Required document executable is unavailable')
}
function canonical(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path || path === '/') throw new Error('Use dedicated absolute document paths')
  let ancestor = path
  while (!existsSync(ancestor)) ancestor = dirname(ancestor)
  if (realpathSync(ancestor) !== ancestor) throw new Error('Document grants cannot traverse symlinks')
  return path
}
function inside(parent: string, path: string): boolean {
  const child = relative(parent, path)
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
}
function overlaps(a: string, b: string): boolean { return inside(a, b) || inside(b, a) }

/** Bootstrap inspects trusted installed code only, with no document data or inherited credentials. */
async function runtimeProfile(config: DocumentLaunchConfiguration, uv: string): Promise<RuntimeProfile> {
  const key = `${uv}\0${config.projectRoot}`
  const cached = profiles.get(key)
  if (cached) return cached
  const code = 'import sys,json,importlib.util,pathlib;spec=importlib.util.find_spec("docatlas_dsh_sidecar");print(json.dumps({"executable":sys.executable,"prefix":sys.prefix,"basePrefix":sys.base_prefix,"codeRoot":str(pathlib.Path(spec.origin).resolve().parent.parent),"version":".".join(map(str,sys.version_info[:3]))}))'
  const { stdout } = await execute(uv, ['run', '--locked', '--no-sync', '--project', config.projectRoot, 'python', '-I', '-c', code],
    { cwd: config.projectRoot, env, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 })
  const profile = JSON.parse(stdout) as RuntimeProfile
  if (profile.version !== '3.12.12' || [profile.executable, profile.prefix, profile.basePrefix, profile.codeRoot].some(path => typeof path !== 'string' || !isAbsolute(path) || !existsSync(path))) throw new Error('Document Python runtime does not match the installed baseline')
  if (profiles.size >= 16) profiles.clear()
  profiles.set(key, profile)
  return profile
}

/** Empty root filesystem, clean environment and only explicitly granted runtime/data mounts. */
export async function documentLaunch(config: DocumentLaunchConfiguration, command: 'docatlas-sidecar' | 'docatlas-tree'): Promise<{ command: string, args: string[], env: NodeJS.ProcessEnv }> {
  if (process.platform !== 'linux' || !existsSync('/usr/bin/bwrap')) throw new Error('Document runtime requires the Linux execution boundary')
  const cacheRoot = canonical(config.cacheRoot)
  const protectedRoots = (config.protectedRoots ?? []).map(canonical)
  const roots = Object.entries(config.sourceRoots).map(([id, path]) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) throw new Error('Invalid source root identity')
    const root = canonical(path)
    if (!statSync(root).isDirectory() || overlaps(root, cacheRoot)) throw new Error('Source roots and document cache must be separate directories')
    return { id, path: root }
  })
  for (const denied of protectedRoots) if ([cacheRoot, ...roots.map(root => root.path)].some(path => overlaps(path, denied))) throw new Error('Document grant overlaps protected application state')
  const uv = executablePath(config.uvCommand ?? 'uv')
  const profile = await runtimeProfile(config, uv)
  const runtimeRoots = [...new Set(['/usr', '/bin', '/lib', '/lib64', profile.prefix, profile.basePrefix, profile.codeRoot])]
  for (const denied of protectedRoots) if (runtimeRoots.some(path => overlaps(path, denied))) throw new Error('Private state cannot reside inside a document runtime mount')
  mkdirSync(cacheRoot, { recursive: true, mode: 0o700 })
  const args = ['--unshare-user', '--unshare-pid', '--unshare-net', '--unshare-ipc', '--die-with-parent', '--new-session', '--tmpfs', '/tmp']
  for (const path of runtimeRoots) args.push('--ro-bind', path, path)
  if (!runtimeRoots.some(path => inside(path, uv))) args.push('--ro-bind', uv, uv)
  args.push('--proc', '/proc', '--dev', '/dev', '--dir', '/data', '--bind', cacheRoot, '/data/cache', '--dir', '/input')
  const options = ['--cache-root', '/data/cache']
  if (command === 'docatlas-sidecar' && roots.length === 0) options.push('--cache-only')
  if (command === 'docatlas-sidecar') for (const [index, root] of roots.entries()) {
    const target = `/input/source-${index}`
    args.push('--ro-bind', root.path, target); options.push('--source-root', `${root.id}=${target}`)
  }
  const module = command === 'docatlas-sidecar' ? 'docatlas_dsh_sidecar' : 'docatlas_dsh_sidecar.tree_cli'
  const code = `import sys,resource,runpy;resource.setrlimit(resource.RLIMIT_AS,(4294967296,4294967296));resource.setrlimit(resource.RLIMIT_NOFILE,(256,256));sys.path.insert(0,${JSON.stringify(profile.codeRoot)});runpy.run_module(${JSON.stringify(module)},run_name="__main__")`
  args.push('--chdir', '/tmp', '--', uv, '--no-cache', 'run', '--offline', '--no-project', '--no-config', '--no-sync', '--python', profile.executable,
    'python', '-I', '-B', '-c', code, ...options)
  return { command: '/usr/bin/bwrap', args, env: { ...env, UV_CACHE_DIR: '/tmp/uv-cache' } }
}
