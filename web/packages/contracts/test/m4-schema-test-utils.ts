import { readFileSync } from 'node:fs'

import { Ajv2020, type AnySchema, type ValidateFunction } from 'ajv/dist/2020.js'
import * as addFormatsModule from 'ajv-formats'
import type { FormatsPlugin } from 'ajv-formats'

const addFormats = addFormatsModule.default as unknown as FormatsPlugin

const SCHEMA_FILES = {
  'claim-version': 'claim/claim-version.schema.json',
  'evidence-relation': 'claim/evidence-relation.schema.json',
  'derivation-activity': 'claim/derivation-activity.schema.json',
  'review-result': 'review/review-result.schema.json',
  'artifact-manifest': 'artifact/artifact-manifest.schema.json',
} as const

export type M4SchemaName = keyof typeof SCHEMA_FILES

const contractRoot = new URL('../../../contracts/', import.meta.url)

export function m4Validators(): Record<M4SchemaName, ValidateFunction> {
  const ajv = new Ajv2020({ allErrors: true, strict: true })
  addFormats(ajv)
  const common = readJson('protocol/common.schema.json') as AnySchema
  ajv.addSchema(common)
  const result = {} as Record<M4SchemaName, ValidateFunction>
  for (const [name, path] of Object.entries(SCHEMA_FILES) as Array<[M4SchemaName, string]>) {
    const schema = readJson(path) as AnySchema
    ajv.addSchema(schema)
    const validator = ajv.getSchema((schema as { $id: string }).$id)
    if (validator === undefined) throw new Error(`missing M4 schema validator for ${name}`)
    result[name] = validator
  }
  return result
}

export function readM4Fixture<T>(name: string): T {
  return readJson(`fixtures/m4/${name}`) as T
}

export interface InvalidM4Case {
  schemaName: M4SchemaName
  baseFixture: string
  description: string
  path: string
  value: unknown
}

export function materializeInvalidCase(testCase: InvalidM4Case): unknown {
  const [filename, fragment = ''] = testCase.baseFixture.split('#')
  if (filename === undefined) throw new Error('invalid fixture reference')
  const document = structuredClone(readM4Fixture<unknown>(filename))
  const base = resolvePointer(document, fragment)
  setPointer(base, testCase.path, testCase.value)
  return base
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, contractRoot), 'utf8')) as unknown
}

function resolvePointer(value: unknown, pointer: string): unknown {
  if (pointer === '') return value
  let current = value
  for (const token of pointerTokens(pointer)) {
    if (typeof current !== 'object' || current === null) throw new Error(`invalid fixture pointer: ${pointer}`)
    current = (current as Record<string, unknown>)[token]
  }
  return current
}

function setPointer(value: unknown, pointer: string, replacement: unknown): void {
  const tokens = pointerTokens(pointer)
  const last = tokens.pop()
  if (last === undefined) throw new Error('fixture mutation cannot replace its root')
  let current = value
  for (const token of tokens) {
    if (typeof current !== 'object' || current === null) throw new Error(`invalid mutation pointer: ${pointer}`)
    current = (current as Record<string, unknown>)[token]
  }
  if (typeof current !== 'object' || current === null) throw new Error(`invalid mutation pointer: ${pointer}`)
  ;(current as Record<string, unknown>)[last] = replacement
}

function pointerTokens(pointer: string): string[] {
  if (!pointer.startsWith('/')) throw new Error(`invalid JSON pointer: ${pointer}`)
  return pointer.slice(1).split('/').map(token => token.replaceAll('~1', '/').replaceAll('~0', '~'))
}
