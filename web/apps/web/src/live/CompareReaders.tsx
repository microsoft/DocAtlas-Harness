import { lazy, Suspense, useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { ProductSelectionProposal, ProductSourceRef } from '@docatlas/contracts'
import { Icon } from '../icons'
import { readerSourceIdentity, type AnswerReturn, type ReaderNavigation, type ReaderPane, type ReaderState } from './reader-state'
import { useUi } from './locale'
import { WorkingIndicator } from './WorkingIndicator'
import type { OutlineLoader } from './DocumentOutline'
import type { MapSummaryAccess } from './MapNodeSummary'
import type { MapResearchAccess } from './map-research'

const Reader = lazy(async () => ({ default: (await import('../ContinuousPdfReader')).ContinuousPdfReader }))
export function readerPaneVisible(state: ReaderState, pane: ReaderPane, narrow: boolean): boolean {
  return state.visible && (pane === 'A' || state.compare) && (!narrow || state.surface === 'reader' && state.active === pane)
}

export function CompareReaders({ navigation, canSelect, onSelect, onLibrary, onAnswer, onChat, canSaveResearch = false, onSaveResearch, onSourceResearch, loadOutline, summaryAccess, researchAccess }: {
  navigation: ReaderNavigation, state: ReaderState, canSelect: boolean,
  onSelect(proposal: ProductSelectionProposal): void, onLibrary(pane: ReaderPane): void, onAnswer(anchor: AnswerReturn): void, onChat(): void,
  canSaveResearch?: boolean, onSaveResearch?(proposal: ProductSelectionProposal): void, onSourceResearch?(source: ProductSourceRef, physicalPage: number): void,
  loadOutline?: OutlineLoader | undefined,
  summaryAccess?: MapSummaryAccess | undefined,
  researchAccess?: MapResearchAccess | undefined,
}) {
  const state = useSyncExternalStore(navigation.subscribe, navigation.state)
  const { t } = useUi()
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 1100px)').matches)
  useEffect(() => { const media = window.matchMedia('(max-width: 1100px)'), change = () => setNarrow(media.matches); media.addEventListener('change', change); return () => media.removeEventListener('change', change) }, [])
  return <div className={`live-readers ${state.compare ? 'is-compare' : ''} ${state.visible ? '' : 'is-closed'}`} role={narrow && state.surface === 'reader' ? 'main' : 'complementary'} aria-label={t('Reading and comparison', '阅读与对照')}>
    {narrow && state.surface === 'reader' && <h1 className="sr-only">{t('Document reader', '文档阅读')}</h1>}
    <div className="live-reader-controls" role="group" aria-label={t('Reader controls', '阅读工作面')}>
      <button className="text-action live-reader-surface-switch" onClick={() => { navigation.showChat(); onChat() }}><Icon name="chat" size={15} />{t('Chat', '对话')}</button>
      <button className="live-reader-surface-switch" aria-pressed={state.surface === 'reader' && state.active === 'A'} onClick={() => navigation.activate('A')}>{state.compare ? t('View A', '查看 A 原文') : t('View PDF', '查看原文')}</button>
      {state.compare && <button aria-pressed={state.surface === 'reader' && state.active === 'B'} onClick={() => navigation.activate('B')}>{t('View B', '查看 B 原文')}</button>}
      <button className="text-action" onClick={() => navigation.setCompare(!state.compare)}><Icon name="split" size={14} />{state.compare ? t('Exit compare', '退出对照') : t('Compare', '对照阅读')}</button>
      <button className="text-action" onClick={() => { navigation.close(); onChat() }}>{t('Close reader', '收起阅读区')}</button>
    </div>
    {state.compare && <p className="live-compare-hint">{t(`Citations open in ${state.active}. Each document scrolls independently.`, `引用打开到 ${state.active} · A / B 的页码、选区和滚动互不联动`)}</p>}
    <div className="live-reader-panes">{(['A', 'B'] as const).map(pane => <ReaderPaneView key={pane} pane={pane} navigation={navigation} state={state} visible={readerPaneVisible(state, pane, narrow)} canSelect={canSelect} onSelect={onSelect} onLibrary={onLibrary} onAnswer={onAnswer} canSaveResearch={canSaveResearch} onSaveResearch={onSaveResearch} onSourceResearch={onSourceResearch} loadOutline={loadOutline} summaryAccess={summaryAccess} researchAccess={researchAccess} />)}</div>
  </div>
}

function ReaderPaneView({ pane, navigation, state, visible, canSelect, onSelect, onLibrary, onAnswer, canSaveResearch, onSaveResearch, onSourceResearch, loadOutline, summaryAccess, researchAccess }: {
  pane: ReaderPane, navigation: ReaderNavigation, state: ReaderState, visible: boolean, canSelect: boolean,
  onSelect(proposal: ProductSelectionProposal): void, onLibrary(pane: ReaderPane): void, onAnswer(anchor: AnswerReturn): void,
  canSaveResearch: boolean, onSaveResearch: ((proposal: ProductSelectionProposal) => void) | undefined, onSourceResearch: ((source: ProductSourceRef, physicalPage: number) => void) | undefined,
  loadOutline?: OutlineLoader | undefined,
  summaryAccess?: MapSummaryAccess | undefined,
  researchAccess?: MapResearchAccess | undefined,
}) {
  const { t } = useUi()
  const cursor = state.panes[pane], location = cursor.location, identity = location ? readerSourceIdentity(location.source) : ''
  const onPages = useCallback((_id: string, pages: number) => navigation.pages(pane, identity, pages), [navigation, pane, identity])
  return <section className={`live-reader-pane ${visible ? 'is-visible' : 'is-hidden'}`} data-reader-pane={pane} aria-label={t(`Original ${pane}`, `原文 ${pane}`)}>
    <div className="live-reader-pane-heading">{state.compare && <button aria-pressed={state.active === pane} onClick={() => navigation.activate(pane)}>{pane}{state.active === pane ? t(' · citation target', ' · 引用目标') : t(' · use for citations', ' · 设为引用目标')}</button>}
      <button className="text-action" disabled={!cursor.back.length} onClick={() => navigation.back(pane)} aria-label={t(`Back in ${pane}`, `返回 ${pane} 上一处`)}><Icon name="history" size={13} />{t('Back', '返回上一处')}</button>
      {location?.answer && <button className="text-action" onClick={() => { navigation.showChat(); onAnswer(location.answer!) }}>{location.focus?.context === 'selection' ? t('Back to message', '回到这条消息') : t('Back to answer', '回到引用回答')}</button>}
      {state.compare && <button className="text-action" onClick={() => onLibrary(pane)}>{t(`Choose document ${pane}`, `选择 ${pane} 资料`)}</button>}
      {location?.source.serverRevision && onSourceResearch && <button className="text-action reader-secondary-action" onClick={() => onSourceResearch({ ...location.source.serverRevision! }, location.page)}>{t('Page notes', '查看此页研究')}</button>}
    </div>
    {cursor.pending !== null && <div className="live-reader-pending"><WorkingIndicator small label={t('Checking source', '正在核对来源')} /></div>}
    {location ? <><p hidden className="live-reader-identity" data-source-document={location.source.serverRevision!.documentId} data-source-revision={location.source.serverRevision!.revisionId} />
      <Suspense fallback={<WorkingIndicator label={t('Loading reader', '正在加载阅读器')} />}><Reader source={location.source} page={location.page} focus={location.focus} focusOnLocate={visible && state.active === pane}
        viewState={location.view} restoreToken={{ id: cursor.navigation, mode: cursor.restore }} onViewState={view => navigation.view(pane, view)} onInteraction={() => navigation.interact(pane)}
        onPage={(page, scrolled) => scrolled ? navigation.visiblePage(pane, identity, page) : navigation.page(pane, identity, page)} onPages={onPages} onSelect={quote => { if (canSelect || canSaveResearch) navigation.select(pane, identity, quote) }}
        onClose={() => navigation.close()} onLibrary={() => onLibrary(pane)} allowSelection={canSelect || canSaveResearch} loadOutline={loadOutline} summaryAccess={summaryAccess} researchAccess={researchAccess} /></Suspense>
      {location.selection && <div className="live-pane-selection"><span>{t(`Selection · p. ${location.selection.page}`, `${pane} 已选片段 · 第 ${location.selection.page} 页`)}</span><button disabled={!canSelect} onClick={() => { const proposal = navigation.selection(pane); if (proposal) onSelect(proposal) }}>{t('Ask about this', '加入问题')}</button>
        <button disabled={!canSaveResearch || !onSaveResearch} onClick={() => { const proposal = navigation.selection(pane); if (proposal) onSaveResearch?.(proposal) }}>{t('Save note', '保存到研究')}</button></div>}
    </> : <div className="live-reader-empty"><p>{t(`Choose an original PDF for ${pane}`, `为 ${pane} 选择一份原始 PDF`)}</p><button className="secondary-button" onClick={() => onLibrary(pane)}>{t(`Choose document ${pane}`, `选择 ${pane} 资料`)}</button><small>{t('Question sources stay unchanged. Each PDF has its own page position.', '不会改变当前问题的资料范围，也不会按相同页码对齐。')}</small></div>}
  </section>
}
