import { useState } from 'react'
import type { TreeNode } from '@docatlas/contracts'
import type { DocumentTreeState } from './document-tree'
import { Icon } from '../icons'
import { useUi } from './locale'
import { WorkingIndicator } from './WorkingIndicator'

export type { OutlineLoader } from './document-tree'
export function outlineRows(nodes: readonly TreeNode[], collapsed: ReadonlySet<string>, query: string) {
  const byId = new Map(nodes.map(node => [node.nodeId, node])), search = query.trim().toLocaleLowerCase()
  return nodes.flatMap(node => {
    const seen = new Set([node.nodeId]); let parent = byId.get(node.parentId ?? ''), depth = 0, hidden = false
    while (parent && depth < 24 && !seen.has(parent.nodeId)) { seen.add(parent.nodeId); hidden ||= collapsed.has(parent.nodeId); depth++; parent = byId.get(parent.parentId ?? '') }
    return search ? node.title.toLocaleLowerCase().includes(search) ? [{ node, depth }] : [] : hidden ? [] : [{ node, depth }]
  })
}
export function DocumentOutline({ tree, page, onMap, onPage, onClose }: { tree: DocumentTreeState, page: number, onMap(): void,
  onPage(page: number): void, onClose(): void }) {
  const { t } = useUi(), { result, nodes, busy, error, read } = tree
  const [query, setQuery] = useState(''), [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const parents = new Set(nodes.map(node => node.parentId)), rows = outlineRows(nodes, collapsed, query)
  const current = [...nodes].filter(node => node.startPage <= page && node.endPage >= page).sort((a, b) => (a.endPage - a.startPage) - (b.endPage - b.startPage))[0]
  return <aside className="document-outline" aria-label={t('Document outline', '文档目录')}>
    <header><strong>{t('Contents', '目录')}</strong><button className="icon-button" onClick={onClose} aria-label={t('Close contents', '收起目录')}><Icon name="close" size={15} /></button></header>
    <button className="outline-map-link" onClick={onMap}><Icon name="map" size={15} />{t('Explore document map', '探索文档地图')}<Icon name="expand" size={12} /></button>
    <label className="outline-search"><Icon name="search" size={15} /><input aria-label={t('Find a section', '查找章节')} placeholder={t('Find a section…', '查找章节…')} value={query} onChange={event => setQuery(event.target.value)} /></label>
    <nav aria-label={t('Sections', '章节')}><ul>{rows.map(({ node, depth }) => <li key={node.nodeId} style={{ paddingLeft: Math.min(depth, 8) * 12 }} data-outline-node={node.nodeId}>
      {parents.has(node.nodeId) ? <button className="outline-toggle" aria-label={t(`Toggle ${node.title}`, `展开或收起 ${node.title}`)} aria-expanded={!collapsed.has(node.nodeId)}
        onClick={() => setCollapsed(old => { const next = new Set(old); if (next.has(node.nodeId)) next.delete(node.nodeId); else next.add(node.nodeId); return next })}><Icon name="chevron" size={12} /></button> : <span className="outline-leaf" />}
      <button className="outline-target" aria-current={current?.nodeId === node.nodeId ? 'location' : undefined} title={node.title} onClick={() => onPage(node.startPage)}><span>{node.title}</span><small>{node.startPage}</small></button>
    </li>)}</ul></nav>
    {busy && <WorkingIndicator label={t('Loading contents', '正在加载目录')} small />}
    {error && <p className="outline-note">{t('Contents are unavailable. The PDF is still readable.', '目录暂不可用，仍可继续阅读原文。')}<button onClick={() => void read(result?.tree.nextOffset ?? 0)}>{t('Retry', '重试')}</button></p>}
    {!busy && !error && !nodes.length && <p className="outline-note">{t('No sections were detected. Use the page controls or scroll to read.', '没有识别到章节，可使用页码或滚动阅读。')}</p>}
    {!!query && !rows.length && nodes.length > 0 && <p className="outline-note">{t('No matching section in the loaded contents.', '已加载目录中没有匹配章节。')}</p>}
    {result?.tree.nextOffset != null && <button className="outline-more" disabled={busy || nodes.length >= 2000} onClick={() => void read(result.tree.nextOffset!)}>{nodes.length >= 2000 ? t('Contents limit reached', '已达目录显示上限') : t('Load more sections', '加载更多章节')}</button>}
    <footer>{t('Document structure · navigation only', '文档结构 · 仅用于导航')}</footer>
  </aside>
}
