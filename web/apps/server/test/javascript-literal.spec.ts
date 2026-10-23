import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { javascriptString } from './javascript-literal.js'

it.each([
  '/tmp/a "quoted" path/with\\backslashes',
  '</script><script>globalThis.injected = true</script>',
  '"; globalThis.injected = true; //',
  '\u0000\b\f\n\r\t\u2028\u2029',
  '中文文档 📄',
])('preserves fixture data without interpreting it as JavaScript: %j', value => {
  const literal = javascriptString(value), context = {}
  expect(literal).not.toMatch(/[<>\u2028\u2029]/u)
  expect(JSON.parse(literal)).toBe(value)
  expect(runInNewContext(`(${literal})`, context)).toBe(value)
  expect(context).toEqual({})
})
