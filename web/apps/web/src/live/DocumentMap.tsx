import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PdfReaderSource } from '../PdfReader'
import { Icon } from '../icons'
import { useUi } from './locale'
import { WorkingIndicator } from './WorkingIndicator'
import type { DocumentTreeState } from './document-tree'
import { documentMapLayout, MAP_NODE_HEIGHT, MAP_NODE_WIDTH, sectionAtPage, sectionDepths, sectionTrail } from './map-layout'
import { MapNodeSummary, type MapSummaryAccess } from './MapNodeSummary'
import { researchDisplayNode, useMapResearch, type MapResearchAccess } from './map-research'
import { MapResearchDetails } from './MapResearchDetails'
import './document-map.css'

/** A read-only map of this exact original's saved structure. Not a knowledge graph or Evidence. */
export function DocumentMap({ source, tree, page, onPage, onClose, summaryAccess, researchAccess }: { source: PdfReaderSource, tree: DocumentTreeState, page: number, onPage(page: number): void, onClose(): void, summaryAccess?: MapSummaryAccess | undefined, researchAccess?: MapResearchAccess | undefined }) {
  const { t } = useUi(), titleId = useId(), dialog = useRef<HTMLDialogElement>(null), canvas = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState<'map' | 'list'>(() => window.matchMedia('(max-width: 700px)').matches ? 'list' : 'map')
  const [query, setQuery] = useState(''), [selectedId, setSelectedId] = useState<string | null>(null), [branch, setBranch] = useState<string | undefined>()
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set()), [zoom, setZoom] = useState(.85)
  const [researchVisible, setResearchVisible] = useState(true), research = useMapResearch(source, tree.nodes, researchAccess)
  const researchById = useMemo(() => new Map(research.nodes.map(node => [node.id, node])), [research.nodes])
  const displayNodes = useMemo(() => researchVisible ? [...tree.nodes, ...research.nodes.map(researchDisplayNode)] : tree.nodes, [tree.nodes, research.nodes, researchVisible])
  const selectedResearch = researchVisible ? researchById.get(selectedId ?? '') : undefined
  const researchNames = { note: t('Note', '笔记'), question: t('Question', '问题'), claim: t('Claim', '结论'), review: t('Review', '审阅') }
  const [closing, setClosing] = useState(false), closingRef = useRef(false), closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const active = sectionAtPage(tree.nodes, page), selected = tree.nodes.find(node => node.nodeId === selectedId) ?? active ?? tree.nodes[0]
  const selectedVisualId = selectedResearch?.id ?? selected?.nodeId
  const filtered = useMemo(() => displayNodes.filter(node => `${node.title}\n${researchById.get(node.nodeId)?.preview ?? tree.summaryPreviews.get(node.nodeId)?.preview ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [displayNodes, tree.summaryPreviews, researchById, query])
  const layout = useMemo(() => documentMapLayout(displayNodes, collapsed, branch), [displayNodes, collapsed, branch])
  const depths = useMemo(() => sectionDepths(displayNodes), [displayNodes])
  const trail = selectedResearch?.parentId ? sectionTrail(tree.nodes, selectedResearch.parentId) : selected ? sectionTrail(tree.nodes, selected.nodeId) : []
  const roots = tree.nodes.filter(node => node.parentId === null), pageCount = tree.result?.generation.pageCount ?? source.pages ?? 1
  const drag = useRef<{ id: number, x: number, y: number, left: number, top: number } | null>(null)
  useEffect(() => {
    const previous = document.activeElement, element = dialog.current
    element?.showModal()
    return () => { clearTimeout(closeTimer.current); element?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }) }
  }, [])
  function close() {
    if (closingRef.current) return
    closingRef.current = true
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { onClose(); return }
    setClosing(true); closeTimer.current = setTimeout(onClose, 140)
  }
  function center(id: string, nextZoom = zoom) {
    requestAnimationFrame(() => {
      const node = layout.nodes.find(node => node.id === id), view = canvas.current
      if (node && view) view.scrollTo({ left: Math.max(0, (node.x + MAP_NODE_WIDTH / 2) * nextZoom - view.clientWidth / 2),
        top: Math.max(0, (node.y + MAP_NODE_HEIGHT / 2) * nextZoom - view.clientHeight / 2), behavior: 'auto' })
    })
  }
  function fit() {
    const view = canvas.current
    if (!view) return
    const scale = Math.max(.5, Math.min(1, (view.clientWidth - 40) / layout.width, (view.clientHeight - 40) / layout.height))
    setZoom(scale); view.scrollTo({ top: 0, left: 0 })
  }
  useEffect(() => { if (mode === 'map' && tree.nodes.length) fit() }, [mode, tree.nodes.length, branch])
  const clampZoom = (value: number) => Math.max(.5, Math.min(1.5, value))
  return createPortal(<dialog ref={dialog} className={`document-map-dialog ${closing ? 'is-closing' : ''}`} aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); close() }} onClick={event => { if (event.target === dialog.current) close() }}>
    <div className="document-map-surface">
      <header className="map-heading"><div className="map-identity"><span className="map-brand"><Icon name="map" size={24} /></span><div><h1 id={titleId}>{t('Document map', '文档地图')}</h1><p title={source.name}>{source.name}</p></div></div>
        <div className="map-heading-actions"><span className="map-readonly">{t('Structure, not evidence', '结构导航，不是证据')}</span><button className="icon-button" aria-label={t('Close document map', '关闭文档地图')} onClick={close}><Icon name="close" /></button></div></header>
      <div className="map-toolbar"><label className="map-search"><Icon name="search" size={16} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('Find a chapter…', '查找章节…')} aria-label={t('Search document map', '搜索文档地图')} />{query && <button aria-label={t('Clear search', '清除搜索')} onClick={() => setQuery('')}><Icon name="close" size={13} /></button>}</label>
        <div className="map-view-switch" role="group" aria-label={t('Map view', '地图视图')}><button aria-pressed={mode === 'map'} onClick={() => setMode('map')}><Icon name="map" size={14} />{t('Map', '地图')}</button><button aria-pressed={mode === 'list'} onClick={() => setMode('list')}><Icon name="note" size={14} />{t('Outline', '大纲')}</button></div>
        {researchAccess && <div className="map-view-switch map-layer-switch" role="group" aria-label={t('Document map layers', '文档地图图层')}><button aria-pressed={!researchVisible} onClick={() => { setResearchVisible(false); if (selectedResearch) setSelectedId(selectedResearch.parentId) }}>{t('Original', '原始结构')}</button><button aria-pressed={researchVisible} onClick={() => setResearchVisible(true)}>{t('Research', '研究视图')}{research.nodes.length > 0 && <span className="map-research-count">{research.nodes.length}</span>}</button></div>}
        <span className="map-loaded-count">{t(`${tree.nodes.length} of ${tree.result?.tree.total ?? '…'} sections`, `${tree.nodes.length} / ${tree.result?.tree.total ?? '…'} 章节`)}</span>
        <button className="map-current" disabled={!active} onClick={() => { setQuery(''); setSelectedId(active!.nodeId); setBranch(undefined); setCollapsed(new Set()); center(active!.nodeId) }}><span className="map-current-dot" />{t(`Reading p. ${page}`, `正在阅读第 ${page} 页`)}</button></div>
      {researchAccess && researchVisible && <div className="map-research-bar"><div className="map-research-legend"><span className="is-original">{t('Original', '原结构')}</span><span className="is-added">{t('Added research', '新增研究')}</span><span className="is-updated">{t('Revised record', '已修订')}</span></div>
        {research.busy && <WorkingIndicator small />}
        {research.review && research.review.scopeOptions.filter(option => option.sourceRefs?.some(ref => ref.documentId === source.serverRevision?.documentId && ref.revisionId === source.serverRevision?.revisionId)).length > 1 && <select aria-label={t('Map review scope', '地图审阅范围')} value={research.review.scope?.scopeVersionId ?? ''} disabled={research.busy} onChange={event => research.setScope(event.target.value)}>{research.review.scopeOptions.filter(option => option.sourceRefs?.some(ref => ref.documentId === source.serverRevision?.documentId && ref.revisionId === source.serverRevision?.revisionId)).map(option => <option key={option.scopeVersionId} value={option.scopeVersionId}>{t('Review', '审阅')} v{option.version}</option>)}</select>}
        <button disabled={research.busy} onClick={research.refresh}>{t('Refresh updates', '刷新研究更新')}</button>{research.canMore && <button disabled={research.busy || research.nodes.length >= 60} onClick={() => void research.more()}>{t('More research', '更多研究')}</button>}
        {(research.noteError || research.reviewError || research.invalid) && <span role="status">{t('Some research could not be verified.', '部分研究状态暂不可核对。')}</span>}
        {research.clipped && <span>{t('Bounded research view', '当前研究视图有界')}</span>}</div>}
      <div className="map-body"><div className="map-exploration">
        {tree.busy && !tree.nodes.length ? <div className="map-empty" role="status"><div className="map-loading-art" aria-hidden="true"><i /><i /><i /><i /></div><WorkingIndicator label={t('Loading document structure', '正在加载文档结构')} /><h2>{t('Connecting the chapters', '正在展开章节结构')}</h2><p>{t('Reading the structure of this original PDF. No model is called.', '读取这份原始 PDF 的目录结构，不调用模型。')}</p></div>
          : !displayNodes.length ? <div className="map-empty"><Icon name="map" size={36} /><h2>{tree.error ? t('The map is unavailable', '地图暂时不可用') : t('This document has no detected outline', '这份文档还没有识别到目录')}</h2><p>{t('The original PDF is still available. No chapters have been invented.', '仍可阅读原始 PDF，没有补造章节。')}</p>{tree.error && <button className="map-primary" onClick={() => void tree.read()}>{t('Try again', '重试')}</button>}</div>
          : mode === 'list' || query ? <nav className="map-outline-view" aria-label={t('Document map sections', '地图章节列表')}>
            {!filtered.length && <p className="map-no-results">{t('No matching chapter in the loaded outline.', '已加载目录中没有匹配章节。')}</p>}
            <ul>{filtered.map(node => { const record = researchById.get(node.nodeId); return <li key={node.nodeId} className={record ? `map-research-row change-${record.change}` : ''} data-map-research={record?.recordId}><button aria-pressed={selectedVisualId === node.nodeId} style={{ paddingLeft: 18 + Math.min(depths.get(node.nodeId) ?? 0, 7) * 18 }} onClick={() => setSelectedId(node.nodeId)}><Icon name={record ? 'note' : 'file'} size={15} /><span>{record && <small className="map-research-type">{researchNames[record.kind]}{record.version !== null ? ` · v${record.version}` : ''} · {record.change === 'updated' ? t('Updated', '已修订') : t('Research', '研究')}</small>}<strong>{node.title}</strong>{tree.summaryPreviews.has(node.nodeId) && <span className="map-outline-summary">{tree.summaryPreviews.get(node.nodeId)!.preview}</span>}</span><small>{node.startPage === node.endPage ? node.startPage : `${node.startPage}–${node.endPage}`}</small></button></li> })}</ul>
          </nav> : <>
            <div className="map-canvas" ref={canvas} tabIndex={0} role="region" aria-label={t('Chapter relationship canvas', '章节关系画布')}
              onPointerDown={event => { if (event.button !== 0 || event.pointerType !== 'mouse' || (event.target as Element).closest('button')) return
                const view = event.currentTarget; drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: view.scrollLeft, top: view.scrollTop }; view.setPointerCapture(event.pointerId) }}
              onPointerMove={event => { const origin = drag.current; if (!origin || origin.id !== event.pointerId) return; event.currentTarget.scrollLeft = origin.left + origin.x - event.clientX; event.currentTarget.scrollTop = origin.top + origin.y - event.clientY }}
              onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }} onLostPointerCapture={() => { drag.current = null }}>
              <div className="map-extent" style={{ width: layout.width * zoom, height: layout.height * zoom }}>
                <div className="map-world" style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})` }}>
                  <svg className="map-connections" width={layout.width} height={layout.height} aria-hidden="true">{layout.links.map(({ from, to }) => {
                    const x = from.x + MAP_NODE_WIDTH, y = from.y + MAP_NODE_HEIGHT / 2, end = to.x, mid = (x + end) / 2
                    return <path key={`${from.id}:${to.id}`} className={`${trail.some(node => node.nodeId === to.id) ? 'is-on-path' : ''} ${researchById.has(to.id) ? 'is-research-link' : ''}`} d={`M${x},${y} C${mid},${y} ${mid},${to.y + MAP_NODE_HEIGHT / 2} ${end},${to.y + MAP_NODE_HEIGHT / 2}`} />
                  })}</svg>
                  {layout.nodes.map(box => { const record = researchById.get(box.id); return <article key={box.id} className={`map-node branch-${Math.max(0, box.branch) % 3} ${box.node ? '' : 'is-document'} ${selectedVisualId === box.id ? 'is-selected' : ''} ${active?.nodeId === box.id ? 'is-current' : ''} ${record ? `is-research change-${record.change}` : ''}`}
                    data-map-node={box.id} data-map-research={record?.recordId} style={{ width: MAP_NODE_WIDTH, height: MAP_NODE_HEIGHT, transform: `translate(${box.x}px, ${box.y}px)` }}>
                    <button className="map-node-main" aria-label={record ? `${researchNames[record.kind]}: ${record.title}` : box.node ? t(`Select section: ${box.node.title}`, `选择章节：${box.node.title}`) : t('Whole document', '完整文档')} aria-pressed={selectedVisualId === box.id} title={box.node?.title ?? source.name}
                      onClick={() => { if (box.node) setSelectedId(box.id); else { setBranch(undefined); setCollapsed(new Set()); fit() } }}>
                      <small>{record ? `${researchNames[record.kind]} · p. ${record.physicalPage}${record.version !== null ? ` · v${record.version}` : ''}` : box.node ? t(`Pages ${box.node.startPage}–${box.node.endPage}`, `第 ${box.node.startPage}–${box.node.endPage} 页`) : t(`${pageCount} pages`, `${pageCount} 页`)}</small><strong>{box.node?.title ?? source.name}</strong>{box.node && <span className={`map-node-summary ${tree.summaryPreviews.has(box.id) || record ? '' : 'is-empty'}`}>{record ? record.change === 'updated' ? t('Updated research record', '已修订的研究记录') : record.change === 'added' ? t('Added research · not a PDF heading', '新增研究 · 不是原文标题') : t('Linked research state', '关联研究状态') : tree.summaryPreviews.get(box.id)?.preview ?? t('Select to add a summary', '选择章节可生成摘要')}</span>}</button>
                    {box.node && box.children > 0 && <button className="map-node-toggle" aria-label={t(`Toggle branch: ${box.node.title}`, `展开或收起分支：${box.node.title}`)} aria-expanded={!collapsed.has(box.id)} onClick={() => setCollapsed(old => { const next = new Set(old); if (next.has(box.id)) next.delete(box.id); else next.add(box.id); return next })}><Icon name={collapsed.has(box.id) ? 'plus' : 'minus'} size={12} /><span>{box.children}</span></button>}
                  </article> })}
                </div>
              </div>
            </div>
            <div className="map-canvas-controls"><button aria-label={t('Zoom out map', '缩小地图')} disabled={zoom <= .5} onClick={() => setZoom(value => clampZoom(value - .15))}><Icon name="minus" size={16} /></button><span>{Math.round(zoom * 100)}%</span><button aria-label={t('Zoom in map', '放大地图')} disabled={zoom >= 1.5} onClick={() => setZoom(value => clampZoom(value + .15))}><Icon name="plus" size={16} /></button><button onClick={fit}>{t('Fit', '适合画布')}</button>
              <button onClick={() => { setCollapsed(new Set()); setBranch(undefined) }}>{t('Show all', '显示全部')}</button>{branch && <button onClick={() => setBranch(undefined)}>{t('Whole document', '完整文档')}</button>}</div>
          </>}
        {(layout.clipped || layout.partialParents || tree.hasMore || tree.error) && tree.nodes.length > 0 && <div className="map-scope-note" role="status">
          {tree.hasMore ? t('More sections are available.', '还有尚未加载的章节。') : layout.clipped ? t('Map is bounded. Use the outline or focus a branch to explore more.', '地图已限制显示数量，请用大纲或聚焦分支继续。') : layout.partialParents ? t('Some parent sections are unavailable; their hierarchy is incomplete.', '部分父章节不可用，当前层级不完整。') : t('The next section batch could not be loaded.', '下一批章节未能加载。')}
          {(tree.hasMore || tree.error) && <button disabled={tree.busy || tree.atLimit} onClick={() => void tree.read(tree.result?.tree.nextOffset ?? 0)}>{tree.busy ? t('Loading…', '加载中…') : tree.atLimit ? t('Display limit reached', '已达显示上限') : t('Load more', '加载更多')}</button>}</div>}
      </div>
      <aside className="map-inspector" aria-label={t('Selected section', '选中章节')}>
        {selectedResearch && researchAccess ? <MapResearchDetails key={selectedResearch.id} node={selectedResearch} access={researchAccess} onClose={onClose} /> : selected ? <><div className="map-section-caption"><Icon name="file" size={15} />{t('Selected section', '选中章节')}</div>
          <h2>{selected.title}</h2><p className="map-section-pages">{t(`Pages ${selected.startPage}–${selected.endPage}`, `第 ${selected.startPage}–${selected.endPage} 页`)}<span>{t(`${selected.endPage - selected.startPage + 1} pages`, `共 ${selected.endPage - selected.startPage + 1} 页`)}</span></p>
          <div className="map-page-range" aria-hidden="true"><i style={{ left: `${(selected.startPage - 1) / pageCount * 100}%`, width: `${(selected.endPage - selected.startPage + 1) / pageCount * 100}%` }} /></div>
          {tree.result && <MapNodeSummary key={`${selected.nodeId}:${tree.summaryPreviews.get(selected.nodeId)?.resultHash ?? ''}`} source={source} generation={tree.result.generation} node={selected} preview={tree.summaryPreviews.get(selected.nodeId)} access={summaryAccess} onUpdated={() => void tree.read()} />}
          {researchVisible && research.nodes.some(item => item.parentId === selected.nodeId) && <div className="map-section-research"><h3>{t('Research updates', '研究更新')}</h3>{research.nodes.filter(item => item.parentId === selected.nodeId).slice(0, 8).map(item => <button key={item.id} className={`change-${item.change}`} onClick={() => { setSelectedId(item.id); center(item.id) }}><span>{researchNames[item.kind]}{item.version !== null ? ` · v${item.version}` : ''}</span><strong>{item.title}</strong></button>)}</div>}
          <nav className="map-trail" aria-label={t('Chapter path', '章节路径')}>{trail.map(node => <button key={node.nodeId} onClick={() => setSelectedId(node.nodeId)}><span /><span>{node.title}</span></button>)}</nav>
          {!!selected.keyItems.length && <details className="map-key-items"><summary>{t('Indexed items', '索引条目')}</summary><ul>{selected.keyItems.slice(0, 30).map((item, index) => <li key={index}>{item}</li>)}</ul>{selected.keyItems.length > 30 && <p>{t('First 30 items shown.', '显示前 30 个条目。')}</p>}</details>}
          <div className="map-inspector-actions"><button className="map-primary" onClick={() => { onPage(selected.startPage); close() }}><Icon name="book" size={16} />{t('Read this section', '阅读这一节')}</button>
            <button className="map-secondary" onClick={() => { setBranch(selected.nodeId); setCollapsed(new Set()); setQuery(''); setMode('map') }}><Icon name="map" size={15} />{t('Focus this branch', '聚焦这一分支')}</button></div>
          <p className="map-inspector-note">{t('These are navigation locations, not verified claims. Open the original to check its contents.', '这些是导航位置，不是已核验结论。请打开原文核对内容。')}</p></>
          : <div className="map-inspector-empty"><Icon name="map" size={28} /><p>{t('Select a chapter to explore its place in the document.', '选择章节，查看它在文档中的位置。')}</p></div>}
      </aside></div>
      <footer className="map-footer"><span>{t('Across the document', '文档全览')}</span><div className="map-page-strip" role="group" aria-label={t('Chapter page distribution', '章节页码分布')}>
        {roots.slice(0, 120).map((node, index) => <button key={node.nodeId} className={`branch-${index % 3}`} style={{ left: `${(node.startPage - 1) / pageCount * 100}%`, width: `${(node.endPage - node.startPage + 1) / pageCount * 100}%` }} title={`${node.title} (${node.startPage}–${node.endPage})`} aria-label={t(`Locate chapter: ${node.title}`, `定位章节：${node.title}`)} onClick={() => { setSelectedId(node.nodeId); center(node.nodeId) }} />)}
        <span className="map-reading-marker" style={{ left: `${(page - 1) / pageCount * 100}%` }} /></div><span>{pageCount} {t('pages', '页')}</span></footer>
    </div>
  </dialog>, document.body)
}
