import { productLearning, humanResearch, nativeLineage, nativeControl, productHistory, productHttp, productControl, observations, documentHttp, enrichment, productAnswer, productResearch, productPersonalization, productPersonalizationV2, productReview, productLibrary, productContinuity, productProbe } from './generated-browser-validators.js'
import { productLearningIssues, type ProductLearningValue } from './product-learning-contracts.js'
import { humanResearchIssues, type HumanResearchValue } from './human-research-contracts.js'
import { nativeLineageIssues, type NativeLineageValue } from './native-lineage-contracts.js'
import { nativeControlIssues, type NativeControlValue } from './native-control-contracts.js'
import { productHistoryIssues, type ProductHistoryValue } from './product-history-contracts.js'
import { productProbeIssues, type ProductProbeValue } from './product-probe-contracts.js'
import { productContinuityIssues, type ProductContinuityValue } from './product-continuity-contracts.js'
import { productLibraryIssues, type ProductLibraryValue } from './product-library-contracts.js'
import { productReviewIssues, type ProductReviewValue } from './product-review-contracts.js'
import { productResearchIssues, type ProductResearchValue } from './product-research-contracts.js'
import { productPersonalizationIssues, type ProductPersonalizationValue } from './product-personalization-contracts.js'
import type { ProductPersonalizationV2Value } from './product-personalization-v2-contracts.js'
import { productAnswerIssues, type ProductAnswerValue } from './product-answer-contracts.js'
import { enrichmentIssues, type EnrichmentValue } from './enrichment-contracts.js'
import { productControlIssues, type ProductControlValue } from './product-control-contracts.js'
import { conversationObservationIssues, type ConversationObservationValue } from './observation-contracts.js'
import type { ProductHttpValue } from './product-http-contracts.js'
import { selectionTicketValid, type DocumentHttpValue } from './document-http-contracts.js'
import { libraryRpcIssues } from './library-contracts.js'
import { questionContext } from './generated-browser-validators.js'
import { questionContextIssues, type QuestionContextValue } from './question-context-contracts.js'

interface BrowserContracts { 'question-context': QuestionContextValue }

interface BrowserContracts { 'product-learning': ProductLearningValue, 'human-research': HumanResearchValue, 'native-lineage': NativeLineageValue, 'native-control': NativeControlValue, 'product-history': ProductHistoryValue, 'product-http': ProductHttpValue, 'product-control': ProductControlValue, 'conversation-observation': ConversationObservationValue, 'document-http': DocumentHttpValue, enrichment: EnrichmentValue, 'product-answer': ProductAnswerValue, 'product-research': ProductResearchValue, 'product-personalization': ProductPersonalizationValue, 'product-personalization-v2': ProductPersonalizationV2Value, 'product-review': ProductReviewValue, 'product-library': ProductLibraryValue, 'product-continuity': ProductContinuityValue, 'product-probe': ProductProbeValue }
const validators = { 'product-learning': productLearning, 'human-research': humanResearch, 'native-lineage': nativeLineage, 'native-control': nativeControl, 'product-history': productHistory, 'product-http': productHttp, 'product-control': productControl, 'conversation-observation': observations, 'document-http': documentHttp, enrichment, 'product-answer': productAnswer, 'product-research': productResearch, 'product-personalization': productPersonalization, 'product-personalization-v2': productPersonalizationV2, 'product-review': productReview, 'product-library': productLibrary, 'product-continuity': productContinuity, 'product-probe': productProbe }
export function parseBrowserContract<K extends keyof BrowserContracts>(name: K, value: unknown): BrowserContracts[K] {
  if (name === 'question-context') {
    if (!questionContext(value) || questionContextIssues(value as QuestionContextValue).length) throw new Error('Invalid question context')
    return value as BrowserContracts[K]
  }
  if (!validators[name as keyof typeof validators](value)) throw new Error('Invalid server response')
  if (name === 'product-learning' && productLearningIssues(value as ProductLearningValue).length) throw new Error('Inconsistent preference learning response')
  if (name === 'human-research' && humanResearchIssues(value as HumanResearchValue).length) throw new Error('Inconsistent human research response')
  if (name === 'native-lineage' && nativeLineageIssues(value as NativeLineageValue).length) throw new Error('Inconsistent native lineage response')
  if (name === 'native-control' && nativeControlIssues(value as NativeControlValue).length) throw new Error('Inconsistent native control response')
  if (name === 'product-history' && productHistoryIssues(value as ProductHistoryValue).length) throw new Error('Inconsistent history response')
  if (name === 'product-probe' && productProbeIssues(value as ProductProbeValue).length) throw new Error('Inconsistent controlled presentation response')
  if (name === 'product-continuity' && productContinuityIssues(value as ProductContinuityValue).length) throw new Error('Inconsistent continuity response')
  if (name === 'product-library' && productLibraryIssues(value as ProductLibraryValue).length) throw new Error('Inconsistent revision response')
  if (name === 'product-review' && productReviewIssues(value as ProductReviewValue).length) throw new Error('Inconsistent review response')
  if (name === 'product-research' && productResearchIssues(value as ProductResearchValue).length) throw new Error('Inconsistent research response')
  if ((name === 'product-personalization' || name === 'product-personalization-v2') && productPersonalizationIssues(value as ProductPersonalizationValue | ProductPersonalizationV2Value).length) throw new Error('Inconsistent personalization response')
  if (name === 'product-answer' && productAnswerIssues(value as ProductAnswerValue).length) throw new Error('Inconsistent answer response')
  if (name === 'enrichment' && enrichmentIssues(value as EnrichmentValue).length) throw new Error('Inconsistent enrichment result')
  if (name === 'document-http') { const message = value as DocumentHttpValue; if (message.kind === 'library-response' && (!('resultType' in message.result) || libraryRpcIssues(message.result).length)) throw new Error('Inconsistent Library response') }
  if (name === 'document-http' && (value as DocumentHttpValue).kind === 'selection-ticket' && !selectionTicketValid(value as Extract<DocumentHttpValue, { kind: 'selection-ticket' }>)) throw new Error('Inconsistent selection ticket')
  if (name === 'product-control' && productControlIssues(value as ProductControlValue).length || name === 'conversation-observation' && conversationObservationIssues(value as ConversationObservationValue).length) throw new Error('Inconsistent server response')
  return value as BrowserContracts[K]
}
