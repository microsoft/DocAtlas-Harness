import type { TreeNode } from '@docatlas/contracts'

export const MAP_NODE_WIDTH = 232, MAP_NODE_HEIGHT = 132, MAP_MAX_NODES = 180
export interface MapNode { id: string, parent: string | null, node: TreeNode | null, x: number, y: number, depth: number, branch: number, children: number }
export interface MapLayout { nodes: MapNode[], links: Array<{ from: MapNode, to: MapNode }>, width: number, height: number, clipped: boolean, partialParents: boolean }
/** A document container is explicitly synthetic navigation chrome, never a source node. */
export function documentMapLayout(input: readonly TreeNode[], collapsed: ReadonlySet<string> = new Set(), focusId?: string): MapLayout {
  const byId = new Map(input.slice(0, 2060).map(node => [node.nodeId, node])), children = new Map<string | null, TreeNode[]>()
  let partialParents = false
  for (const node of byId.values()) {
    const parent = node.parentId && byId.has(node.parentId) && node.parentId !== node.nodeId ? node.parentId : null
    if (node.parentId && parent === null) partialParents = true
    children.set(parent, [...(children.get(parent) ?? []), node])
  }
  const nodes: MapNode[] = [], seen = new Set<string>(); let row = 0, clipped = input.length > 2060
  function hasVisibleAncestor(node: TreeNode): boolean {
    let parent = byId.get(node.parentId ?? ''); const visited = new Set<string>()
    while (parent && !visited.has(parent.nodeId)) { if (seen.has(parent.nodeId)) return true; visited.add(parent.nodeId); parent = byId.get(parent.parentId ?? '') }
    return false
  }
  function visit(node: TreeNode, parent: string | null, depth: number, branch: number): MapNode | null {
    if (seen.has(node.nodeId)) { partialParents = true; return null }
    if (nodes.length >= MAP_MAX_NODES || depth > 8) { clipped = true; return null }
    seen.add(node.nodeId)
    const siblings = children.get(node.nodeId) ?? [], box: MapNode = { id: node.nodeId, node, parent, depth, branch, children: siblings.length, x: 36 + depth * 300, y: 0 }
    nodes.push(box)
    const sub = collapsed.has(node.nodeId) ? [] : siblings.flatMap(child => { const item = visit(child, node.nodeId, depth + 1, branch); return item ? [item] : [] })
    box.y = sub.length ? (sub[0]!.y + sub.at(-1)!.y) / 2 : 36 + row++ * (MAP_NODE_HEIGHT + 30)
    return box
  }
  if (focusId && byId.has(focusId)) visit(byId.get(focusId)!, null, 0, 0)
  else {
    const root: MapNode = { id: '@document', node: null, parent: null, depth: 0, branch: -1, children: (children.get(null) ?? []).length, x: 36, y: 36 }
    nodes.push(root)
    const roots = (children.get(null) ?? []).flatMap((node, index) => { const box = visit(node, root.id, 1, index); return box ? [box] : [] })
    // A malformed cycle must not hang or disappear; render its component as a
    // detached root and disclose partial hierarchy, without inventing a parent.
    if (!collapsed.size && nodes.length < MAP_MAX_NODES) for (const node of byId.values()) if (!seen.has(node.nodeId) && !hasVisibleAncestor(node)) {
      partialParents = true; const box = visit(node, root.id, 1, roots.length); if (box) roots.push(box)
    }
    root.y = roots.length ? (roots[0]!.y + roots.at(-1)!.y) / 2 : 36
  }
  const boxes = new Map(nodes.map(node => [node.id, node])), links = nodes.flatMap(to => { const from = boxes.get(to.parent ?? ''); return from ? [{ from, to }] : [] })
  return { nodes, links, width: Math.max(600, ...nodes.map(node => node.x + MAP_NODE_WIDTH + 36)), height: Math.max(300, ...nodes.map(node => node.y + MAP_NODE_HEIGHT + 36)), clipped, partialParents }
}
export function sectionAtPage(nodes: readonly TreeNode[], page: number): TreeNode | undefined {
  return nodes.filter(node => node.startPage <= page && node.endPage >= page).sort((a, b) => a.endPage - a.startPage - (b.endPage - b.startPage))[0]
}
export function sectionTrail(nodes: readonly TreeNode[], id: string): TreeNode[] {
  const byId = new Map(nodes.map(node => [node.nodeId, node])), seen = new Set<string>(), result: TreeNode[] = []
  let item = byId.get(id)
  while (item && !seen.has(item.nodeId) && result.length < 24) { seen.add(item.nodeId); result.unshift(item); item = byId.get(item.parentId ?? '') }
  return result
}
export function sectionDepths(nodes: readonly TreeNode[]): ReadonlyMap<string, number> {
  const byId = new Map(nodes.map(node => [node.nodeId, node])), result = new Map<string, number>()
  for (const node of nodes) {
    const seen = new Set([node.nodeId]); let parent = byId.get(node.parentId ?? ''), depth = 0
    while (parent && !seen.has(parent.nodeId) && depth < 24) { depth++; seen.add(parent.nodeId); parent = byId.get(parent.parentId ?? '') }
    result.set(node.nodeId, depth)
  }
  return result
}
