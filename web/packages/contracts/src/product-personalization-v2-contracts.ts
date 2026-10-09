import type { ProductPreferenceCommand, ProductPreferenceInspection, ProductPreferenceResult } from './product-personalization-contracts.js'

/** Envelope v2; actions and inner durable personalization records intentionally retain v1. */
export interface ProductPreferenceCommandV2 extends Omit<ProductPreferenceCommand, 'schemaVersion'> { schemaVersion: 2, expectedProfileEpoch: number }
export interface ProductPreferenceInspectionV2 extends Omit<ProductPreferenceInspection, 'schemaVersion' | 'modelApplication'> {
  schemaVersion: 2
  /** Monotonic privacy-erasure generation; not a profile ID or a setting revision. */
  profileEpoch: number
  modelApplication: 'host-ephemeral' | 'not-connected'
  /** Observed generation, never proof of model compliance, correct facts, or rendered UI. */
  useSemantics: 'observed-answer-generation'
}
export interface ProductPreferenceResultV2 extends Omit<ProductPreferenceResult, 'schemaVersion'> { schemaVersion: 2 }
export type ProductPersonalizationV2Value = ProductPreferenceCommandV2 | ProductPreferenceInspectionV2 | ProductPreferenceResultV2
