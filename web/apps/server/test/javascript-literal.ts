/** Encode fixture data as a JavaScript string literal, including script delimiters. */
export function javascriptString(value: string): string {
  return JSON.stringify(value).replace(/[<>\u2028\u2029]/gu,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
}
