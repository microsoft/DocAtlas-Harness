import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Core extraction ownership', () => {
  const sourceRoot = new URL('../src/', import.meta.url)
  const allowedImport = (value: string, file: URL) => {
    if (value.startsWith('node:') || value === '@docatlas/contracts' || value.startsWith('@docatlas/contracts/')) return true
    if (!value.startsWith('./') && !value.startsWith('../') || !value.endsWith('.js')) return false
    const target = new URL(value.replace(/\.js$/, '.ts'), file)
    return target.href.startsWith(sourceRoot.href) && existsSync(target)
  }
  it('has no Pi/DSH/React/server imports in its implementation or dependencies', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(manifest.dependencies).toEqual({ '@docatlas/contracts': 'workspace:*' })
    const files = readdirSync(new URL('../src/storage/', import.meta.url))
    expect(files.length).toBe(5)
    for (const file of files) {
      const text = readFileSync(new URL(`../src/storage/${file}`, import.meta.url), 'utf8')
      const imports = [...text.matchAll(/from ['"]([^'"]+)['"]/g)].map(match => match[1]!)
      expect(imports.every(value => allowedImport(value, new URL(`storage/${file}`, sourceRoot))), file).toBe(true)
      expect(text).not.toMatch(/import\(['"](?:@deepseek|@earendil|react|.*plugins\/|.*apps\/)/)
    }
    // Domain subdirectories are legitimate Core dependencies; follow their source
    // imports too, so allowing storage -> personalization cannot hide a host import.
    for (const name of readdirSync(sourceRoot, { recursive: true, encoding: 'utf8' }).filter(name => name.endsWith('.ts'))) {
      const file = new URL(name, sourceRoot), source = readFileSync(file, 'utf8')
      const imports = [...source.matchAll(/from ['"]([^'"]+)['"]/g)].map(match => match[1]!)
      expect(imports.every(value => allowedImport(value, file)), name).toBe(true)
      expect(source).not.toMatch(/import\(['"](?:@deepseek|@earendil|react|.*plugins\/|.*apps\/)/)
    }
    const store = new URL('storage/personalization-store.ts', sourceRoot)
    expect(allowedImport('../personalization/learning.js', store)).toBe(true)
    for (const external of ['../../../../apps/server/src/index.js', '../../package.json', '@docatlas/runtime-pi', '@docatlas/contracts-untrusted', 'react']) expect(allowedImport(external, store)).toBe(false)
  })
  it('keeps document application/ports independent of both host runtimes', () => {
    for (const file of readdirSync(new URL('../src/document/', import.meta.url))) {
      const source = readFileSync(new URL(`../src/document/${file}`, import.meta.url), 'utf8')
      expect(source).not.toMatch(/(?:from\s+|import\()['"](?:@deepseek|@earendil|react|@docatlas\/(?:runtime|server)|.*plugins\/|.*apps\/)/)
    }
    const manifest = JSON.parse(readFileSync(new URL('../../runtime-document/package.json', import.meta.url), 'utf8'))
    expect(manifest.dependencies).toEqual({ '@docatlas/contracts': 'workspace:*', '@docatlas/core': 'workspace:*' })
    for (const file of readdirSync(new URL('../../runtime-document/src/', import.meta.url))) {
      const source = readFileSync(new URL(`../../runtime-document/src/${file}`, import.meta.url), 'utf8')
      expect(source).not.toMatch(/(?:from\s+|import\()['"](?:@deepseek|@earendil|react)/)
    }
  })
})
