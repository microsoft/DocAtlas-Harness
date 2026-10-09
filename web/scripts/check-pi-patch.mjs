import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const baseline = JSON.parse(readFileSync(join(root, 'compat/pi/patch-baseline.json'), 'utf8'))
const hash = value => createHash('sha256').update(value).digest('hex')
if (baseline.schemaVersion !== 1 || baseline.version !== '0.85.1') throw new Error('Unknown Pi patch baseline')
const installed = realpathSync(join(root, 'packages/runtime-pi/node_modules', baseline.package))
const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
if (manifest.version !== baseline.version) throw new Error('Pi release changed; patch and native parity must be reviewed')
const patch = readFileSync(join(root, baseline.patchPath), 'utf8')
if (hash(patch) !== baseline.patchSha256) throw new Error('Pi patch changed without a compatibility review')
const patchedFiles = [...patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)].map(match => match[2]).sort()
if (JSON.stringify(patchedFiles) !== JSON.stringify(Object.keys(baseline.files).sort())) throw new Error('Patch file inventory drifted')
for (const [path, expected] of Object.entries(baseline.files)) {
  if (hash(readFileSync(join(installed, path))) !== expected) throw new Error(`Installed Pi patch mismatch: ${path}`)
}
// Security overrides must preserve the imported provider capability closure.
// Resolve only: never execute provider/extension factories during this check.
const modelRequire = createRequire(realpathSync(join(root, 'packages/runtime-pi/node_modules/@earendil-works/pi-ai/package.json')))
const providerManifest = modelRequire.resolve.paths('@google/genai')?.map(path => join(path, '@google/genai/package.json')).find(existsSync)
if (!providerManifest) throw new Error('Native Google provider dependency was removed')
createRequire(realpathSync(providerManifest)).resolve('@modelcontextprotocol/sdk/client/index.js')
console.log(`Pi ${manifest.version} / ${baseline.revision}: patch and ${patchedFiles.length} installed files verified`)
console.log('Native provider MCP peer resolution verified without executing factories')
