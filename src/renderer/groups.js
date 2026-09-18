/**
 * 分屏树（窗口级的区域划分）
 *
 *   Leaf  : { kind:'leaf',  id, groupId }
 *   Split : { kind:'split', id, dir:'row'|'col', ratio, a, b }
 *
 * dir:'row' = 左右并排，dir:'col' = 上下堆叠。
 *
 * 这棵树决定「区域」（group）在窗口里的排布；每个区域自己有一条页签栏，
 * 所以分割线会从窗口顶部一直贯穿到底，把页签栏也切开。
 */

let seq = 0
export function nextId(prefix) {
  seq += 1
  return `${prefix}${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export function createLeaf(groupId) {
  return { kind: 'leaf', id: nextId('n'), groupId }
}

export function findLeaf(node, groupId) {
  if (!node) return null
  if (node.kind === 'leaf') return node.groupId === groupId ? node : null
  return findLeaf(node.a, groupId) || findLeaf(node.b, groupId)
}

export function firstLeaf(node) {
  if (!node) return null
  return node.kind === 'leaf' ? node : firstLeaf(node.a)
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

/** 用新的叶子替换掉指定的叶子（区域被清空后复用它的位置） */
export function replaceLeaf(root, groupId, replacement) {
  const leaf = findLeaf(root, groupId)
  if (!leaf) return root
  if (root === leaf) return replacement
  return replaceNode(root, leaf.id, replacement)
}

/** 在指定区域旁边再切一块出来 */
export function splitLeaf(root, groupId, dir, newGroupId, { before = false } = {}) {
  const leaf = findLeaf(root, groupId)
  if (!leaf) return root
  const branch = {
    kind: 'split',
    id: nextId('s'),
    dir,
    ratio: 0.5,
    a: before ? createLeaf(newGroupId) : leaf,
    b: before ? leaf : createLeaf(newGroupId),
  }
  if (root === leaf) return branch
  return replaceNode(root, leaf.id, branch)
}

/** 移除某个区域，父分支塌缩成兄弟节点 */
export function removeLeaf(root, groupId) {
  const leaf = findLeaf(root, groupId)
  if (!leaf) return { root, removed: false }
  if (root === leaf) return { root: null, removed: true }
  return removeById(root, leaf.id)
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

/** 计算每个区域在窗口里的相对矩形（0~1），用于方向导航 */
export function groupRects(root) {
  const out = new Map()
  const walk = (node, box) => {
    if (!node) return
    if (node.kind === 'leaf') {
      out.set(node.groupId, box)
      return
    }
    if (node.dir === 'row') {
      const aw = box.w * node.ratio
      walk(node.a, { x: box.x, y: box.y, w: aw, h: box.h })
      walk(node.b, { x: box.x + aw, y: box.y, w: box.w - aw, h: box.h })
    } else {
      const ah = box.h * node.ratio
      walk(node.a, { x: box.x, y: box.y, w: box.w, h: ah })
      walk(node.b, { x: box.x, y: box.y + ah, w: box.w, h: box.h - ah })
    }
  }
  walk(root, { x: 0, y: 0, w: 1, h: 1 })
  return out
}

/** 方向导航：找相邻的那个区域 */
export function neighborGroup(root, groupId, dir) {
  const rects = groupRects(root)
  if (rects.size < 2) return null
  const current = rects.get(groupId)
  if (!current) return null

  const cx = current.x + current.w / 2
  const cy = current.y + current.h / 2
  let best = null
  let bestScore = Infinity

  for (const [id, rect] of rects) {
    if (id === groupId) continue
    const ox = rect.x + rect.w / 2
    const oy = rect.y + rect.h / 2
    let ok = false
    let dist = 0
    if (dir === 'left') {
      ok = ox < cx - 0.001
      dist = cx - ox + Math.abs(oy - cy) * 2
    } else if (dir === 'right') {
      ok = ox > cx + 0.001
      dist = ox - cx + Math.abs(oy - cy) * 2
    } else if (dir === 'up') {
      ok = oy < cy - 0.001
      dist = cy - oy + Math.abs(ox - cx) * 2
    } else {
      ok = oy > cy + 0.001
      dist = oy - cy + Math.abs(ox - cx) * 2
    }
    if (ok && dist < bestScore) {
      bestScore = dist
      best = id
    }
  }
  return best
}
