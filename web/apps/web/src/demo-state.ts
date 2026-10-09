export const SAMPLE_ID = 'sample:widget-2025'
export const SAMPLE_SHA = '161ea6a246e2520ec26795013d24a9deb8f60f471acd0cdf7ea273a43a6e8fb4'
export const MAX_LOCAL_PDF_BYTES = 25 * 1024 * 1024

export interface DemoDocument {
  id: string
  name: string
  url: string
  kind: 'sample' | 'local'
  sha256: string
  pages: number | null
  bytes: number
}

export const SAMPLE_DOCUMENT: DemoDocument = {
  id: SAMPLE_ID,
  name: 'Annual Widget Report 2025.pdf',
  url: '/documents/sample-report.pdf',
  kind: 'sample',
  sha256: SAMPLE_SHA,
  pages: 6,
  bytes: 11_668,
}

export interface QuoteContext {
  documentId: string
  page: number
  quote: string
}

export interface Citation extends QuoteContext {
  id: string
  label: string
  number: number
}

export const CITATIONS: Record<string, Citation> = {
  revenue: { id: 'revenue', documentId: SAMPLE_ID, page: 2, quote: 'Q4 15.2 +9%', label: '第四季度营收', number: 1 },
  region: {
    id: 'region', documentId: SAMPLE_ID, page: 3,
    quote: 'The West region grew fastest year over year, driven by new distribution partners.',
    label: '区域增长', number: 2,
  },
  risk: { id: 'risk', documentId: SAMPLE_ID, page: 6, quote: 'Risks include supply variability and competitive pricing pressure.', label: '风险与展望', number: 3 },
  roadmap: { id: 'roadmap', documentId: SAMPLE_ID, page: 5, quote: 'Widget Pro launch in Q1', label: '产品路线', number: 4 },
  quarters: { id: 'quarters', documentId: SAMPLE_ID, page: 2, quote: 'Q1 12.3 +4% Q2 13.1 +7% Q3 14.0 +7% Q4 15.2 +9%', label: '季度营收表', number: 1 },
}

export type AnswerKind = 'overview' | 'revenue' | 'risk' | 'selection' | 'local' | 'unsupported' | 'cancelled'
export type ReadingStyle = 'concise' | 'guided'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  answer: AnswerKind | null
  context: QuoteContext | null
  sourceId: string | null
}

export interface DemoRun {
  id: string
  answer: AnswerKind
  sourceId: string | null
  context: QuoteContext | null
  phase: 'reading' | 'composing'
}

export interface DemoNote extends QuoteContext { id: string }

export interface DemoState {
  messages: ChatMessage[]
  selectedDocumentId: string | null
  context: QuoteContext | null
  run: DemoRun | null
  notes: DemoNote[]
  style: ReadingStyle
}

export const initialDemoState: DemoState = {
  messages: [], selectedDocumentId: null, context: null, run: null, notes: [], style: 'concise',
}

export type DemoAction =
  | { type: 'select-document', documentId: string | null }
  | { type: 'context', context: QuoteContext | null }
  | { type: 'submit', id: string, text: string, answer: AnswerKind }
  | { type: 'phase', id: string }
  | { type: 'complete', id: string }
  | { type: 'cancel' }
  | { type: 'new-chat' }
  | { type: 'save-note', note: DemoNote }
  | { type: 'remove-note', id: string }
  | { type: 'style', style: ReadingStyle }

export function classifyAnswer(text: string, document: DemoDocument | null, context: QuoteContext | null): AnswerKind {
  if (context && context.documentId === document?.id) return 'selection'
  if (document?.kind === 'local') return 'local'
  if (!document) return 'unsupported'
  if (/营收|收入|季度|revenue|quarter|增长.*多少|计算/i.test(text)) return 'revenue'
  if (/风险|展望|2026|risk|outlook/i.test(text)) return 'risk'
  if (/总结|摘要|概览|报告|概况|summary|overview/i.test(text)) return 'overview'
  return 'unsupported'
}

export function demoReducer(state: DemoState, action: DemoAction): DemoState {
  switch (action.type) {
    case 'select-document':
      return { ...state, selectedDocumentId: action.documentId, context: state.context?.documentId === action.documentId ? state.context : null }
    case 'context':
      return { ...state, context: action.context, selectedDocumentId: action.context?.documentId ?? state.selectedDocumentId }
    case 'submit': {
      if (state.run || !action.text.trim()) return state
      const context = state.context?.documentId === state.selectedDocumentId ? state.context : null
      return {
        ...state,
        messages: [...state.messages, { id: `${action.id}:user`, role: 'user', text: action.text.trim(), answer: null, context, sourceId: state.selectedDocumentId }],
        context: null,
        run: { id: action.id, answer: action.answer, sourceId: state.selectedDocumentId, context, phase: 'reading' },
      }
    }
    case 'phase':
      return state.run?.id === action.id ? { ...state, run: { ...state.run, phase: 'composing' } } : state
    case 'complete': {
      if (state.run?.id !== action.id) return state
      return {
        ...state,
        messages: [...state.messages, {
          id: `${action.id}:assistant`, role: 'assistant', text: '', answer: state.run.answer,
          context: state.run.context, sourceId: state.run.sourceId,
        }],
        run: null,
      }
    }
    case 'cancel':
      return state.run ? {
        ...state,
        messages: [...state.messages, { id: `${state.run.id}:cancelled`, role: 'assistant', text: '', answer: 'cancelled', context: null, sourceId: null }],
        run: null,
      } : state
    case 'new-chat':
      return { ...state, messages: [], run: null, context: null, selectedDocumentId: null }
    case 'save-note':
      return state.notes.some(note => note.documentId === action.note.documentId && note.page === action.note.page && note.quote === action.note.quote)
        ? state : { ...state, notes: [...state.notes, action.note] }
    case 'remove-note':
      return { ...state, notes: state.notes.filter(note => note.id !== action.id) }
    case 'style':
      return { ...state, style: action.style }
  }
}

export function localPdfError(file: Pick<File, 'name' | 'size'>): string | null {
  if (!file.name.toLowerCase().endsWith('.pdf')) return '请选择 PDF 文件。'
  if (file.size === 0) return '这个文件是空的，请选择另一份 PDF。'
  if (file.size > MAX_LOCAL_PDF_BYTES) return '原型支持 25 MB 以内的 PDF。文件不会上传到服务器。'
  return null
}
