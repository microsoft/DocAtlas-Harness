import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ObservationCursor } from '@docatlas/contracts'
import { ConversationObservations, observationId } from '../runs/observations.js'
import { ProductAuth, ApiError } from './auth.js'

/** No await of a browser from model/tool callbacks. Slow connections are retired to snapshot resync. */
export function streamObservations(request: IncomingMessage, response: ServerResponse, auth: ProductAuth, hub: ConversationObservations,
  cursor: ObservationCursor | undefined, released: () => void): void {
  const { actor } = auth.authenticate(request.headers.cookie)
  hub.authorize(actor)
  let stopped = false, unsubscribe = () => {}, unwatch = () => {}, timer: ReturnType<typeof setInterval> | undefined
  const close = () => {
    if (stopped) return
    stopped = true; clearInterval(timer); unsubscribe(); unwatch(); released()
    if (response.headersSent && !response.writableEnded && !response.destroyed) response.end()
  }
  const authorized = () => { auth.authenticate(request.headers.cookie); hub.authorize(actor) }
  const write = (data: string) => {
    if (stopped || response.destroyed) return
    authorized()
    if (response.writableLength + Buffer.byteLength(data) > 131072) { response.destroy(); close(); return }
    response.write(data)
  }
  try {
    unwatch = auth.watch(request.headers.cookie, close)
    response.once('close', close); response.once('error', close)
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    response.setHeader('X-Accel-Buffering', 'no')
    unsubscribe = hub.subscribe(actor, cursor, value => {
      try { write(`id: ${observationId(value.cursor)}\nevent: ${value.update.type === 'resync' ? 'resync' : 'observation'}\ndata: ${JSON.stringify(value)}\n\n`) }
      catch { close() }
    }, close)
    if (stopped) { unsubscribe(); if (!response.headersSent) throw new ApiError('unavailable'); return }
    response.flushHeaders()
    let pulses = 0
    timer = setInterval(() => { try { authorized(); if (++pulses % 15 === 0) write(': heartbeat\n\n') } catch { close() } }, 1000)
    timer.unref()
  } catch (error) { close(); throw error }
}
