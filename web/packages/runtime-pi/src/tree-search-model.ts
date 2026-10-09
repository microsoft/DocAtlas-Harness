import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { Api, Model } from '@earendil-works/pi-ai'
import { createEnrichmentModel } from './enrichment-model.js'

/** Same bounded, joined text-only host transport; no Agent session, tool loop or answer-purpose witness. */
export function createTreeSearchModel(runtime: ModelRuntime, model: Model<Api>, authorize: () => void) {
  return createEnrichmentModel(runtime, model, authorize)
}
