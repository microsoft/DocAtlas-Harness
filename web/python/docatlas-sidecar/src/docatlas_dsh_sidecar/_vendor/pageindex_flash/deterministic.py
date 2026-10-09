"""Exact deterministic function closure from pinned PageIndex; generated, do not edit."""
import re
import sys
ROUTING_COST = 1         # R(v), in pages
TITLE_MAX_CHARS = 200    # a union title longer than this falls back to a page label

def note(enabled, message):
    """Progress line on stderr; stdout keeps only the metrics and the summary."""
    if enabled:
        print(message, file=sys.stderr, flush=True)


def flatten(nodes, parent=None):
    """Depth-first walk yielding (node, parent) for every node in the tree."""
    for node in nodes:
        yield node, parent
        yield from flatten(node.get("nodes") or [], node)


def subtree_end(node):
    """Last page covered by this node or any descendant.

    A node's own end_index already spans its whole subtree (union semantics);
    the walk keeps legacy trees working, where a parent's end_index stopped at
    its first child.
    """
    end = node["end_index"]
    for child, _ in flatten(node.get("nodes") or []):
        end = max(end, child["end_index"])
    return end


def is_frontier(node):
    return not node.get("nodes")


def relabel(structure, width=4):
    """Renumber every node_id in document order: 0000, 0001, 0002, ...

    Expansion mints ids like "0266.1" to show provenance; once the tree is final
    those are replaced by a flat sequence. flatten() is pre-order depth-first,
    which is document order for a well-formed tree.

    Returns the old -> new mapping so a log written against the old ids can still
    be followed.
    """
    mapping = {}
    for counter, (node, _) in enumerate(flatten(structure)):
        old = node.get("node_id")
        new = f"{counter:0{width}d}"
        if old is not None:
            mapping[old] = new
        node["node_id"] = new
    return mapping


def pages_of(node):
    return set(range(node["start_index"], subtree_end(node) + 1))


def S(node):
    """Pages to scan linearly if this node were collapsed."""
    return subtree_end(node) - node["start_index"] + 1


def S_residual(node):
    """Pages of the node covered by no child."""
    children = node.get("nodes") or []
    if not children:
        return S(node)
    covered = set()
    for child in children:
        covered |= pages_of(child)
    return len(pages_of(node) - covered)


def tree_cost(node, routing=ROUTING_COST):
    """Worst-case search cost of the subtree as it currently stands."""
    if is_frontier(node):
        return S(node)
    branches = [tree_cost(c, routing) for c in node["nodes"]]
    residual = S_residual(node)
    if residual:
        branches.append(residual)
    return routing + max(branches)


def frontier_costs(node, distance=0):
    """Every branch as (routing distance, scan pages, label) - the frontier form.

    Distances are returned unweighted; the caller multiplies by R.
    """
    if is_frontier(node):
        return [(distance, S(node), node.get("node_id"))]
    entries = []
    residual = S_residual(node)
    if residual:
        entries.append((distance + 1, residual, f"{node.get('node_id')}:residual"))
    for child in node["nodes"]:
        entries.extend(frontier_costs(child, distance + 1))
    return entries


def tree_cost_via_frontier(node, routing=ROUTING_COST):
    entries = frontier_costs(node)
    return max(d * routing + s for d, s, _ in entries) if entries else 0


def frontier_nodes(structure, root_depth=1):
    """(node, depth) for every frontier node of the tree.

    depth counts routing visits on the way in. root_depth=1 charges one visit for
    routing at the document level, so a top-level frontier node costs
    1 + pages(u) - the same convention as tree_cost() applied from the document.
    """
    found = []

    def visit(node, depth):
        if is_frontier(node):
            found.append((node, depth))
            return
        for child in node["nodes"]:
            visit(child, depth + 1)
        if S_residual(node):
            # pages held by the node itself are reached by routing into it, then
            # scanning what no child covers
            found.append((node, depth + 1))

    for root in structure:
        visit(root, root_depth)
    return found


def pages(node):
    """Pages that must be scanned once search arrives at this frontier node."""
    return S_residual(node) if not is_frontier(node) else S(node)


def worst_case_search_complexity(structure, root_depth=1, routing=ROUTING_COST):
    """max over frontier u [ R * depth(u) + pages(u) ]"""
    entries = frontier_nodes(structure, root_depth)
    if not entries:
        return 0
    return max(depth * routing + pages(node) for node, depth in entries)


def average_search_complexity(structure, total_pages, root_depth=1, routing=ROUTING_COST):
    """sum over frontier u [ p(u) * (R * depth(u) + (pages(u)+1)/2) ]

    p(u) = pages(u) / total_pages, the chance the target lies in u; the expected
    position of a uniformly placed target inside a linear scan of n pages is
    (n+1)/2.
    """
    if not total_pages:
        return 0.0, 0.0
    total = 0.0
    weight = 0.0
    for node, depth in frontier_nodes(structure, root_depth):
        n = pages(node)
        p = n / total_pages
        weight += p
        total += p * (depth * routing + (n + 1) / 2)
    return total, weight


def normalized_worst_case_complexity(structure, total_pages, root_depth=1,
                                     routing=ROUTING_COST):
    """worst_case_search_complexity(T) / total_pages"""
    if not total_pages:
        return 0.0
    return worst_case_search_complexity(structure, root_depth, routing) / total_pages


def complexity(structure, total_pages, root_depth=1, routing=ROUTING_COST):
    """The three search-complexity metrics for the whole tree."""
    entries = frontier_nodes(structure, root_depth)
    worst = worst_case_search_complexity(structure, root_depth, routing)
    average, weight = average_search_complexity(structure, total_pages,
                                                root_depth, routing)
    depths = [d for _, d in entries]
    return {
        "total_pages": total_pages,
        "frontier_nodes": len(entries),
        "worst_case_search_complexity": worst,
        "average_search_complexity": round(average, 3),
        "normalized_worst_case_complexity": round(
            normalized_worst_case_complexity(structure, total_pages, root_depth, routing), 4),
        "max_depth": max(depths) if depths else 0,
        "mean_depth": round(sum(depths) / len(depths), 2) if depths else 0,
        # 1.0 when frontier pages partition the document; above 1.0 means frontier
        # ranges overlap (the end_index convention lets a section share a page)
        "probability_mass": round(weight, 4),
    }


def structural_issues(node, parent, page_count):
    issues = []
    start, end = node.get("start_index"), node.get("end_index")

    for name, value in (("start_index", start), ("end_index", end)):
        if not isinstance(value, int):
            issues.append(f"{name} is {value!r}, expected an integer")
    if not isinstance(start, int) or not isinstance(end, int):
        return issues

    if start < 1 or start > page_count:
        issues.append(f"start_index {start} outside the PDF (1-{page_count})")
    if end < 1 or end > page_count:
        issues.append(f"end_index {end} outside the PDF (1-{page_count})")
    if start > end:
        issues.append(f"start_index {start} is after end_index {end}")

    # legacy trees let children extend past the parent's end_index, so only the
    # start is checked against the parent
    if parent and isinstance(parent.get("start_index"), int):
        if start < parent["start_index"]:
            issues.append(f"start_index {start} precedes parent "
                          f"{parent.get('node_id')} (starts {parent['start_index']})")
    return issues


def _sibling_groups(nodes, parent_id=None):
    yield parent_id, nodes
    for node in nodes:
        if node.get("nodes"):
            yield from _sibling_groups(node["nodes"], node.get("node_id"))


def ordering_issues(nodes):
    """Siblings must be listed in the order they appear in the document."""
    found = {}
    for _, group in _sibling_groups(nodes):
        previous = None
        for node in group:
            start = node.get("start_index")
            if isinstance(start, int) and isinstance(previous, int) and start < previous:
                found.setdefault(node.get("node_id"), []).append(
                    f"start_index {start} is before the preceding sibling's {previous}")
            if isinstance(start, int):
                previous = start
    return found


def validate(structure, page_count):
    issues = []
    for node, parent in flatten(structure):
        for problem in structural_issues(node, parent, page_count):
            issues.append(f"[{node.get('node_id')}] {problem}")
    for node_id, problems in ordering_issues(structure).items():
        issues.extend(f"[{node_id}] {p}" for p in problems)
    covered = set()
    for node, _ in flatten(structure):
        covered |= set(range(node["start_index"], node["end_index"] + 1))
    gaps = [p for p in range(1, page_count + 1) if p not in covered]
    if gaps:
        issues.append(f"pages covered by no node: {gaps}")
    return issues


def page_label(node):
    """A node's page span, for use as a title of last resort."""
    start, end = node["start_index"], subtree_end(node)
    return f"p.{start}" if start == end else f"p.{start}-{end}"


def union_title(titles, node):
    """The titles of merged same-page siblings, joined.

    Falls back to a page label when the join is empty or too long to serve as a
    title - PRML, for instance, extracts whole exercise bodies as headings, and
    two of those joined run past a thousand characters. Titles reach the model
    (the parent summary prompt lists them, and they survive `format_structure`),
    so this is the field that has to stay readable; `key_items` keeps the
    untruncated original.
    """
    joined = "; ".join(title for title in titles if title)
    if not joined or len(joined) > TITLE_MAX_CHARS:
        return page_label(node)
    return joined


def merge_same_page(structure, log):
    """Collapse frontier siblings that cover exactly the same pages.

    Deterministic and free. Runs before merge() because a narrower tree changes
    its ancestors' tree_cost, and before expand() because children an expand pass
    lands on one page are the same redundancy arriving later.
    """
    changed = False

    def visit(nodes):
        nonlocal changed
        groups = {}
        for node in nodes:
            visit(node.get("nodes") or [])
            if is_frontier(node):
                groups.setdefault((node["start_index"], subtree_end(node)), []).append(node)

        for span, group in groups.items():
            if len(group) < 2:
                continue
            keeper, dropped = group[0], group[1:]
            titles = []
            for node in group:                 # document order, key_items carried forward
                titles.append(node["title"])
                titles.extend(node.get("key_items") or [])
            log.append({"op": "merge_same_page", "node_id": keeper.get("node_id"),
                        "pages": list(span), "dropped": len(dropped),
                        "dropped_ids": [n.get("node_id") for n in dropped],
                        "key_items": titles})
            keeper["key_items"] = titles
            keeper["title"] = union_title(titles, keeper)
            # tells summarize_tree this title was synthesized and may be rewritten;
            # stripped from the output once summaries are done
            keeper["_same_page"] = True
            for node in dropped:
                nodes.remove(node)
            changed = True

    visit(structure)
    return changed


def merge(structure, routing, log, frozen, progress=False):
    """Collapse any subtree whose structure does not beat a linear scan.

    Bottom-up: merging a deep subtree changes its ancestors' tree_cost, so the
    deepest decisions have to be made first.
    """
    changed = False

    def visit(node):
        nonlocal changed
        if is_frontier(node):
            return
        for child in list(node.get("nodes") or []):
            visit(child)
        if is_frontier(node):        # every child collapsed away
            return

        cost = tree_cost(node, routing)
        checked = tree_cost_via_frontier(node, routing)
        span = S(node)
        if span <= cost:
            # trees arrive here before ids are assigned in the main pipeline
            removed = [c.get("node_id") for c, _ in flatten(node["nodes"])]
            # titles are routing information; keep them on the parent, in document
            # order, carrying forward anything an earlier merge already folded in
            titles = []
            for child, _ in flatten(node["nodes"]):
                titles.append(child["title"])
                titles.extend(child.get("key_items") or [])
            log.append({"op": "merge", "node_id": node.get("node_id"),
                        "S": span, "tree_cost": cost, "frontier_cost": checked,
                        "merge_gain": cost - span, "removed": len(removed),
                        "removed_ids": removed, "key_items": titles,
                        "frontier": sorted(frontier_costs(node, routing),
                                           key=lambda e: -(e[0] * routing + e[1]))[:5]})
            node["end_index"] = subtree_end(node)
            node.pop("nodes", None)
            if titles:
                node["key_items"] = titles
            frozen.add(node.get("node_id"))
            changed = True
            note(progress, f"    merge  {node.get('node_id') or '-':>8}  "
                           f"S={span} <= tree_cost={cost}  dropped {len(removed)} node(s)")

    for root in list(structure):
        visit(root)
    return changed


def strip_internal_keys(structure):
    """Drop the bookkeeping keys the optimize/summary passes leave behind."""
    nodes = structure if isinstance(structure, list) else [structure]
    for node in nodes:
        if not isinstance(node, dict):
            continue
        node.pop('_same_page', None)
        if node.get('nodes'):
            strip_internal_keys(node['nodes'])
    return structure

