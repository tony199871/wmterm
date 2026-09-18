/**
 * 分屏树（tmux 式布局的核心数据结构）
 *
 *   Leaf  : { kind:'leaf',  id, paneId }
 *   Split : { kind:'split', id, dir:'row'|'col', ratio, a, b }
 *
 * dir:'row' = 左右并排（子节点横向排列）
 * dir:'col' = 上下堆叠
 *
 * 这个模块只负责纯数据变换，DOM 由 layout-view 负责。
 */

let seq = 0
export function nextId(prefix) {
  seq += 1
  return `${prefix}${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export function createLeaf(paneId) {
  return { kind: 'leaf', id: nextId('n'), paneId }
}

export function isLeaf(node) {
  return !!node && node.kind === 'leaf'
}

export function findLeaf(node, paneId) {
  if (!node) return null
  if (node.kind === 'leaf') return node.paneId === paneId ? node : null
  return findLeaf(node.a, paneId) || findLeaf(node.b, paneId)
}

export function firstLeaf(node) {
  if (!node) return null
  return node.kind === 'leaf' ? node : firstLeaf(node.a)
}

export function lastLeaf(node) {
  if (!node) return null
  return node.kind === 'leaf' ? node : lastLeaf(node.b)
}

export function collectLeaves(node, out = []) {
  if (!node) return out
  if (node.kind === 'leaf') {
    out.push(node)
    return out
  }
  collectLeaves(node.a, out)
  collectLeaves(node.b, out)
  return out
}

export function countLeaves(node) {
  return collectLeaves(node).length
}

/** 在指定叶子上做分割，返回新的根节点 */
export function splitLeaf(root, paneId, dir, newPaneId, { before = false } = {}) {
  const leaf = findLeaf(root, paneId)
  if (!leaf) return root
  const branch = {
    kind: 'split',
    id: nextId('s'),
    dir,
    ratio: 0.5,
    a: before ? createLeaf(newPaneId) : leaf,
    b: before ? leaf : createLeaf(newPaneId),
  }
  if (root === leaf) return branch
  return replaceNode(root, leaf.id, branch)
}

/** 删除叶子，父分支塌缩成兄弟节点 */
export function removeLeaf(root, paneId) {
  const leaf = findLeaf(root, paneId)
  if (!leaf) return { root, removed: false }
  if (root === leaf) return { root: null, removed: true }
  const { node: next, removed } = removeById(root, leaf.id)
  return { root: next, removed }
}

function removeById(node, id) {
  if (!node || node.kind === 'leaf') return { node, removed: false }
  if (node.a.id === id) return { node: node.b, removed: true }
  if (node.b.id === id) return { node: node.a, removed: true }
  const left = removeById(node.a, id)
  if (left.removed) return { node: { ...node, a: left.node }, removed: true }
  const right = removeById(node.b, id)
  if (right.removed) return { node: { ...node, b: right.node }, removed: true }
  return { node, removed: false }
}

function replaceNode(node, targetId, replacement) {
  if (!node) return node
  if (node.id === targetId) return replacement
  if (node.kind === 'leaf') return node
  const a = replaceNode(node.a, targetId, replacement)
  const b = replaceNode(node.b, targetId, replacement)
  if (a === node.a && b === node.b) return node
  return { ...node, a, b }
}

export function updateRatio(node, splitId, ratio) {
  if (!node || node.kind === 'leaf') return node
  if (node.id === splitId) return { ...node, ratio: Math.min(0.92, Math.max(0.08, ratio)) }
  const a = updateRatio(node.a, splitId, ratio)
  const b = updateRatio(node.b, splitId, ratio)
  if (a === node.a && b === node.b) return node
  return { ...node, a, b }
}

/** 键盘方向导航：找相邻窗格 */
export function neighbor(node, paneId, dir) {
  const leaves = collectLeaves(node)
  if (leaves.length < 2) return null
  const index = leaves.findIndex((l) => l.paneId === paneId)
  if (index < 0) return null

  const geometry = (leaf) => {
    // 用「相对坐标 + 深度」近似判断空间关系，够用且不用等 DOM 布局
    const rect = { x: 0, y: 0, w: 1, h: 1 }
    const walk = (n, box) => {
      if (!n) return null
      if (n.kind === 'leaf') return n.id === leaf.id ? box : null
      if (n.dir === 'row') {
        const aw = box.w * n.ratio
        return walk(n.a, { ...box, w: aw }) || walk(n.b, { ...box, x: box.x + aw, w: box.w - aw })
      }
      const ah = box.h * n.ratio
      return walk(n.a, { ...box, h: ah }) || walk(n.b, { ...box, y: box.y + ah, h: box.h - ah })
    }
    return walk(node, rect) || rect
  }

  const current = geometry(leaves[index])
  let best = null
  let bestScore = Infinity

  leaves.forEach((leaf, i) => {
    if (i === index) return
    const r = geometry(leaf)
    const cx = r.x + r.w / 2
    const cy = r.y + r.h / 2
    const ox = current.x + current.w / 2
    const oy = current.y + current.h / 2
    let ok = false
    let dist = 0
    if (dir === 'left') {
      ok = cx < ox - 0.001
      dist = (ox - cx) + Math.abs(cy - oy) * 2
    } else if (dir === 'right') {
      ok = cx > ox + 0.001
      dist = (cx - ox) + Math.abs(cy - oy) * 2
    } else if (dir === 'up') {
      ok = cy < oy - 0.001
      dist = (oy - cy) + Math.abs(cx - ox) * 2
    } else {
      ok = cy > oy + 0.001
      dist = (cy - oy) + Math.abs(cx - ox) * 2
    }
    if (ok && dist < bestScore) {
      bestScore = dist
      best = leaf
    }
  })

  return best ? best.paneId : null
}
