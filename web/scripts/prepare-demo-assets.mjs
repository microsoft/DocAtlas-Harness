import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const root = new URL('../', import.meta.url)
const input = new URL('apps/web/fixtures/sample-report.pdf.base64', root)
const output = new URL('apps/web/public/documents/', root)
const bytes = Buffer.from(await readFile(input, 'utf8'), 'base64')
const expected = '161ea6a246e2520ec26795013d24a9deb8f60f471acd0cdf7ea273a43a6e8fb4'
if (createHash('sha256').update(bytes).digest('hex') !== expected || bytes.subarray(0, 5).toString() !== '%PDF-') {
  throw new Error('Demo PDF fixture identity check failed')
}
await mkdir(output, { recursive: true })
await writeFile(new URL('sample-report.pdf', output), bytes)
const require = createRequire(new URL('apps/web/package.json', root))
const pdfjsRoot = new URL('./', pathToFileURL(require.resolve('pdfjs-dist/package.json')))
for (const name of ['cmaps', 'standard_fonts', 'wasm']) {
  await cp(new URL(`${name}/`, pdfjsRoot), new URL(`apps/web/public/pdfjs/${name}/`, root), { recursive: true })
}
await cp(new URL('LICENSE', pdfjsRoot), new URL('apps/web/public/pdfjs/LICENSE', root))
await mkdir(new URL('apps/web/public/legal/', root), { recursive: true })
await cp(new URL('apps/web/THIRD_PARTY_NOTICES.md', root), new URL('apps/web/public/legal/NOTICE.txt', root))
const fontRoot = new URL('./', pathToFileURL(require.resolve('@fontsource-variable/noto-sans-sc/package.json')))
await cp(new URL('LICENSE', fontRoot), new URL('apps/web/public/legal/NotoSansSC-OFL.txt', root))
for (const [name, notice] of [['dm-sans', 'DMSans-OFL.txt'], ['newsreader', 'Newsreader-OFL.txt']]) {
  const localFont = new URL('./', pathToFileURL(require.resolve(`@fontsource-variable/${name}/package.json`)))
  await cp(new URL('LICENSE', localFont), new URL(`apps/web/public/legal/${notice}`, root))
}
console.log('Demo PDF prepared: exact original bytes, six-page synthetic report; no private files or model calls.')
