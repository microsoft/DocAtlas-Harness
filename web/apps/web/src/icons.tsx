import type { CSSProperties } from 'react'

const paths = {
  book: 'M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-3H4V4Zm16 0h-4a3 3 0 0 0-3 3v14a4 4 0 0 1 4-3h3V4Z',
  plus: 'M12 5v14M5 12h14',
  arrow: 'M12 19V5m-6 6 6-6 6 6',
  chevron: 'm9 5 7 7-7 7',
  close: 'm6 6 12 12M6 18 18 6',
  file: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Zm0 0v6h6M8 13h8M8 17h6',
  upload: 'M12 16V3m-4 4 4-4 4 4M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5',
  history: 'M3 12a9 9 0 1 0 2.64-6.36L3 8m0-5v5h5m4-1v5l3 2',
  note: 'M6 3h12a2 2 0 0 1 2 2v16H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm1 0v18m4-12h5m-5 4h5',
  quote: 'M10 7H4v6h5c0 3-2 5-4 5m15-11h-6v6h5c0 3-2 5-4 5',
  settings: 'M4 7h9m4 0h3M4 17h3m4 0h9M13 4v6M7 14v6',
  check: 'm5 12 4 4L19 6',
  copy: 'M8 8h12v12H8V8Zm8-4H4v12',
  split: 'M3 5h18v14H3V5Zm11 0v14',
  link: 'm10 13 4-4m-5 7-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 0 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0',
  chat: 'M20 11a8 8 0 0 1-8 8H5l-3 3V11a9 9 0 0 1 18 0ZM7 10h8m-8 4h5',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  search: 'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm5-2 6 6',
  map: 'M4 4h6v5H4V4Zm10 11h6v5h-6v-5ZM4 15h6v5H4v-5Zm3-6v6m0-3h10v3',
  info: 'M12 8h.01M12 11v6M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  stop: 'M7 7h10v10H7V7Z',
  minus: 'M5 12h14',
  expand: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5',
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',
} as const

export type IconName = keyof typeof paths

export function Icon({ name, size = 18, style }: { name: IconName, size?: number, style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}>
    <path d={paths[name]} />
  </svg>
}
