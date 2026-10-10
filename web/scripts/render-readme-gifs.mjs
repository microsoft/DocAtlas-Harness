// Documentation-only rendering. No product launch, model call, or state access.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { chromium } from '@playwright/test'

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repository = resolve(webRoot, '..')
const { values } = parseArgs({ options: {
  'web-source': { type: 'string' }, 'tui-source': { type: 'string' },
  stills: { type: 'boolean' }, publish: { type: 'boolean' }, help: { type: 'boolean' },
}, strict: true })

if (values.help) {
  console.log('Use scripts/pnpmw exec node scripts/render-readme-gifs.mjs --web-source /capture/web.mp4 --tui-source /capture/tui.mp4 [--stills | --publish]')
  process.exit(0)
}
assert.equal(process.versions.node, '22.19.0', 'Use the pinned scripts/pnpmw wrapper')
assert.ok(values['web-source'] && values['tui-source'], 'Both reviewed source recordings are required')
assert.ok(!(values.stills && values.publish), '--stills does not publish assets')

const WIDTH = 1440, HEIGHT = 960, FPS = 12
const specs = [
  {
    kind: 'web', title: 'WEB UI', tagline: 'Ask the paper. Follow the evidence.',
    windowTitle: 'DocAtlas — Web UI',
    source: resolve(values['web-source']), sourceHash: '74ffc4fe98b38046c659afddd88f1b8873b57197281e05162383519b4cda4502',
    sourceSize: [1280, 720], sourceDuration: 50,
    target: resolve(webRoot, 'assets/web-ui.gif'), poster: resolve(webRoot, 'assets/web-ui.png'),
    shots: [
      { duration: 2, from: 18.3, to: 18.3, step: '→', action: 'A question, an answer, and the original source.' },
      { duration: 3, from: 0.6, to: 2.8, step: '01', action: 'Upload the DocAtlas paper.' },
      { duration: 5, from: 7.4, to: 10.9, step: '02', action: 'Ask what makes DocAtlas different from static retrieval.' },
      { duration: 3.5, from: 12.4, to: 13.1, step: '03', action: 'Read a concise answer with source citations.' },
      { duration: 2, from: 16.95, to: 18.3, step: '04', action: 'Open a citation in the original PDF.' },
      { duration: 6, from: 18.3, to: 19, step: '04', action: 'Check the highlighted passage on the cited page.' },
      { duration: 3.5, from: 32.9, to: 33.4, step: '05', action: 'Explore the document map and chapter summaries.' },
      { duration: 2, from: 18.3, to: 18.3, step: '→', action: 'Return to the evidence. Keep asking.' },
    ],
  },
  {
    kind: 'tui', title: 'TERMINAL', tagline: 'One paper. A growing research workspace.',
    windowTitle: 'DocAtlas — Terminal',
    source: resolve(values['tui-source']), sourceHash: '44f549901dcaabe05d3c48a13ebee6a1f2a56747e90dee252bdae21166a58566',
    sourceSize: [1536, 864], sourceDuration: 25,
    target: resolve(repository, 'assets/tui-demo.gif'), poster: resolve(repository, 'assets/tui-preview.png'),
    shots: [
      { duration: 2, from: 18.8, to: 18.8, step: '→', action: 'From document search to a page-grounded answer.' },
      { duration: 4, from: 0.25, to: 2.8, step: '01', action: 'Select docatlas-paper.pdf with the keyboard.' },
      { duration: 4, from: 6.6, to: 10.6, step: '02', action: 'Ask a focused question about the paper.' },
      { duration: 5, from: 11.5, to: 17.9, step: '03', action: 'Follow Search, Read, and Note as they run.' },
      { duration: 5, from: 18.25, to: 19.2, step: '04', action: 'Inspect the answer and its page references.' },
      { duration: 5, from: 20.25, to: 24, step: '05', action: 'Open the saved finding and its recorded evidence.' },
      { duration: 3, from: 24, to: 24, step: '05', action: 'Keep the research ready for your next question.' },
    ],
  },
]

const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const probe = path => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height,nb_read_frames:format=duration,size', '-of', 'json', path], { encoding: 'utf8', timeout: 60000 }))
for (const spec of specs) {
  assert.equal(hash(spec.source), spec.sourceHash, `${spec.kind}: reviewed source hash mismatch`)
  const source = probe(spec.source)
  assert.deepEqual([source.streams[0].width, source.streams[0].height], spec.sourceSize)
  assert.ok(Math.abs(Number(source.format.duration) - spec.sourceDuration) < .01)
  for (const shot of spec.shots) {
    assert.ok(shot.duration > 0 && Number.isInteger(shot.duration * FPS))
    assert.ok(shot.from >= 0 && shot.to >= shot.from && shot.to < spec.sourceDuration)
  }
  spec.duration = spec.shots.reduce((sum, shot) => sum + shot.duration, 0)
}

const workRoot = resolve(webRoot, '.cache/readme-gifs')
mkdirSync(workRoot, { recursive: true })
const output = mkdtempSync(resolve(workRoot, 'render-'))
const template = readFileSync(new URL('./readme-media-stage.html', import.meta.url), 'utf8')
const fontRoot = resolve(webRoot, 'apps/web/node_modules/@fontsource-variable')
const font = (family, file) => readFileSync(resolve(fontRoot, family, 'files', file)).toString('base64')
const fonts = `<style>@font-face{font-family:DemoSans;src:url(data:font/woff2;base64,${font('dm-sans', 'dm-sans-latin-wght-normal.woff2')}) format('woff2');font-weight:100 1000}@font-face{font-family:DemoSerif;src:url(data:font/woff2;base64,${font('newsreader', 'newsreader-latin-wght-normal.woff2')}) format('woff2');font-weight:200 800}</style>`
const stagePath = resolve(output, 'stage.html')
writeFileSync(stagePath, template.replace('</head>', `${fonts}</head>`))
const browser = await chromium.launch({ headless: true })
const reports = []

async function frame(page, spec, time) {
  let start = 0
  const shot = spec.shots.find(item => {
    if (time < start + item.duration) return true
    start += item.duration
    return false
  })
  assert.ok(shot, 'Frame must lie within the edit')
  const sourceTime = shot.from + (shot.to - shot.from) * (time - start) / shot.duration
  await page.evaluate(async ({ sourceTime, step, action, progress }) => {
    const video = document.getElementById('recording')
    document.getElementById('step').textContent = step
    document.getElementById('action').textContent = action
    document.getElementById('progress').style.width = `${progress}%`
    if (Math.abs(video.currentTime - sourceTime) > .0001 || video.readyState < 2) {
      await new Promise((accept, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error('Source frame seek timed out')) }, 10000)
        const cleanup = () => { clearTimeout(timer); video.removeEventListener('seeked', ready); video.removeEventListener('error', failed) }
        const ready = () => { cleanup(); accept() }
        const failed = () => { cleanup(); reject(new Error('Source video failed')) }
        video.addEventListener('seeked', ready, { once: true })
        video.addEventListener('error', failed, { once: true })
        video.currentTime = sourceTime
      })
    }
    await new Promise(accept => requestAnimationFrame(() => requestAnimationFrame(accept)))
    if (video.readyState < 2 || Math.abs(video.currentTime - sourceTime) > .04) throw new Error('Decoded frame is not the requested source time')
  }, { sourceTime, step: shot.step, action: shot.action, progress: 100 * time / spec.duration })
}

function encode(args) {
  const child = spawn('ffmpeg', ['-v', 'error', '-nostdin', ...args], { stdio: ['pipe', 'ignore', 'pipe'] })
  let error = ''
  child.stderr.on('data', data => { error += data })
  child.stdin.on('error', failure => { error += `Media encoder input: ${failure.message}\n` })
  const done = once(child, 'close').then(([code]) => { if (code !== 0) throw new Error(`Media encoder failed: ${error}`) })
  // Install a rejection handler immediately while frames are still being rendered.
  void done.catch(() => {})
  return { child, done }
}

async function finishPalette(path) {
  const page = await browser.newPage()
  try {
    const png = await page.evaluate(async encoded => {
      const picture = new Image()
      picture.src = `data:image/png;base64,${encoded}`
      await picture.decode()
      if (picture.width !== 16 || picture.height !== 16) throw new Error('Expected a 256-entry palette')
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 16
      const context = canvas.getContext('2d')
      context.drawImage(picture, 0, 0)
      const pixels = context.getImageData(0, 0, 16, 16)
      if (pixels.data[1023] !== 0) throw new Error('Keep the GIF transparency entry')
      // palettegen uses at most 252 opaque colors. Reserve the three unused
      // opaque entries for the static window controls rather than quantizing
      // red and yellow into the same color. Index 255 stays transparent.
      for (const [index, color] of [[252, [255, 96, 88]], [253, [255, 189, 46]], [254, [40, 200, 64]]]) {
        pixels.data.set([...color, 255], index * 4)
      }
      context.putImageData(pixels, 0, 0)
      return canvas.toDataURL('image/png').split(',')[1]
    }, readFileSync(path).toString('base64'))
    writeFileSync(path, Buffer.from(png, 'base64'))
  } finally { await page.close() }
}

try {
  for (const spec of specs) {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    // Local file assets only. Do not contact a product service or external host.
    await page.route(/^https?:\/\//, route => route.abort())
    await page.goto(pathToFileURL(stagePath).href)
    await page.evaluate(({ source, title, tagline, windowTitle }) => {
      document.getElementById('edition').textContent = title
      document.getElementById('tagline').textContent = tagline
      document.getElementById('window-title').textContent = windowTitle
      document.getElementById('recording').src = source
    }, { source: pathToFileURL(spec.source).href, title: spec.title, tagline: spec.tagline, windowTitle: spec.windowTitle })
    await page.waitForFunction(() => document.getElementById('recording').readyState >= 2)
    await page.evaluate(() => document.fonts.ready)
    const samples = [0]
    let at = 0
    for (const shot of spec.shots) { samples.push(at + shot.duration / 2); at += shot.duration }
    for (const time of samples) {
      await frame(page, spec, time)
      const overflow = await page.evaluate(() => [...document.querySelectorAll('.masthead,.identity,.edition,.tagline,.window,.caption,.action,.disclosure')].filter(element => {
        const rect = element.getBoundingClientRect()
        return rect.left < 0 || rect.right > 1440 || rect.top < 0 || rect.bottom > 960 || element.scrollWidth > element.clientWidth + 1
      }).map(element => element.className))
      assert.deepEqual(overflow, [], `${spec.kind}: layout overflow at ${time}`)
      await page.screenshot({ path: resolve(output, `${spec.kind}-${time.toFixed(2)}.png`), animations: 'disabled' })
    }
    assert.deepEqual(errors, [])
    console.log(`${spec.kind}: ${samples.length} framing/source-seek checks passed`)
    if (values.stills) { await page.close(); continue }

    const lossless = resolve(output, `${spec.kind}.mkv`)
    const encoder = encode(['-f', 'image2pipe', '-framerate', String(FPS), '-vcodec', 'png', '-i', 'pipe:0',
      '-an', '-c:v', 'ffv1', '-level', '3', '-threads', '2', lossless])
    try {
      for (let index = 0; index < spec.duration * FPS; index++) {
        assert.equal(encoder.child.exitCode, null, 'Media encoder exited before the final frame')
        await frame(page, spec, index / FPS)
        const pixels = await page.screenshot({ type: 'png', animations: 'disabled' })
        if (!encoder.child.stdin.write(pixels)) await once(encoder.child.stdin, 'drain')
        if (index % 60 === 0) console.log(`${spec.kind}: ${index}/${spec.duration * FPS} frames`)
      }
      encoder.child.stdin.end()
      await encoder.done
    } finally {
      if (encoder.child.exitCode === null) { encoder.child.kill('SIGTERM'); await encoder.done.catch(() => {}) }
    }
    assert.deepEqual(errors, [])
    await page.close()
    const result = resolve(output, `${spec.kind}.gif`)
    const palette = resolve(output, `${spec.kind}-palette.png`)
    const run = args => execFileSync('ffmpeg', ['-v', 'error', '-nostdin', '-threads', '2', '-filter_threads', '2', ...args], { timeout: 120000 })
    run(['-i', lossless, '-vf', 'palettegen=stats_mode=full:max_colors=253', '-frames:v', '1', palette])
    await finishPalette(palette)
    run(['-i', lossless, '-i', palette, '-filter_complex_threads', '2', '-lavfi', 'paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle', '-loop', '0', result])
    run(['-i', result, '-f', 'null', '-'])
    const metadata = probe(result)
    assert.deepEqual([metadata.streams[0].width, metadata.streams[0].height], [WIDTH, HEIGHT])
    assert.equal(Number(metadata.streams[0].nb_read_frames), spec.duration * FPS)
    assert.ok(Math.abs(Number(metadata.format.duration) - spec.duration) < .03)
    assert.ok(statSync(result).size < 12 * 1024 * 1024, 'GIF exceeds README media budget')
    const bytes = readFileSync(result)
    assert.equal(bytes.subarray(0, 6).toString(), 'GIF89a')
    assert.ok(bytes.includes(Buffer.from('NETSCAPE2.0\x03\x01\x00\x00\x00', 'binary')), 'GIF must loop indefinitely')
    reports.push({ kind: spec.kind, sourceSha256: spec.sourceHash, sourcePixels: spec.sourceSize,
      sourceSeconds: spec.sourceDuration, width: WIDTH, height: HEIGHT, frames: spec.duration * FPS,
      durationSeconds: Number(metadata.format.duration), bytes: bytes.length, sha256: hash(result),
      loop: 'infinite', decodeErrors: 0, checkedStills: samples.length, shots: spec.shots })
    if (values.publish) {
      mkdirSync(dirname(spec.target), { recursive: true })
      copyFileSync(result, spec.target)
      copyFileSync(resolve(output, `${spec.kind}-0.00.png`), spec.poster)
    }
    console.log(`${spec.kind}: complete, ${spec.duration}s, ${(bytes.length / 1024 / 1024).toFixed(2)} MiB`)
  }
} finally { await browser.close() }

for (const spec of specs) assert.equal(hash(spec.source), spec.sourceHash, 'Source recording changed during rendering')

const report = { source: 'DocAtlas promotional demo v9 (retained v5 TUI / Web capture)',
  paper: { title: 'DocAtlas: Long-Document Understanding as Mutable-State Interaction',
    url: 'https://arxiv.org/abs/2608.07527', originalSha256FromVideoProvenance: '69dc16fc994e1fd2118eb11df088d3eaadacdc03da7e6fbf380a52fef4f78fc3' },
  styling: 'macOS-inspired editorial frame; software recorded on Linux',
  timing: 'Edited source clips and reading holds, not a performance measurement',
  sessions: 'Independent recorded Web and TUI sessions; not cross-client synchronization',
  productRuntimeChanged: false, newModelCalls: 0, reports }
writeFileSync(resolve(output, 'verification.json'), `${JSON.stringify(report, null, 2)}\n`)
if (values.publish) writeFileSync(resolve(webRoot, 'assets/readme-media.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(`Media work directory: ${output}`)
