export type WorkerJson = null | boolean | number | string | WorkerJson[] | { [key: string]: WorkerJson }
export type WorkerErrorCode = 'denied' | 'invalid' | 'cancelled' | 'unavailable' | 'limit' | 'failed'
interface FrameBase { version: 1, id: string }
export type WorkerFrame = FrameBase & (
  | { kind: 'call', method: string, value: WorkerJson }
  | { kind: 'yield', sequence: number, value: WorkerJson }
  | { kind: 'return', value: WorkerJson }
  | { kind: 'error', code: WorkerErrorCode }
  | { kind: 'cancel' }
)
