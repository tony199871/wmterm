/**
 * 把分屏树渲染成 DOM，并实现分隔条拖拽。
 *
 * 关键点：叶子节点换成一个「区域」容器，区域内部自带页签栏 + 终端区。
 * 分隔条夹在两个区域之间，所以它会从窗口顶部一直贯穿到底 —— 页签栏也被切开。
 */

export function renderLayout(container, node, { renderLeaf, onRatioChange, onRatioCommit }) {
  container.textContent = ''
  container.appendChild(build(node, renderLeaf, onRatioChange, onRatioCommit))
}

function build(node, renderLeaf, onRatioChange, onRatioCommit) {
  if (!node) return document.createComment('empty')

  if (node.kind === 'leaf') {
    const slot = document.createElement('div')
    slot.className = 'group-slot'
    slot.dataset.group = node.groupId
    slot.appendChild(renderLeaf(node.groupId))
    return slot
  }

  const box = document.createElement('div')
  box.className = `split split-${node.dir}`
  const a = build(node.a, renderLeaf, onRatioChange, onRatioCommit)
  const b = build(node.b, renderLeaf, onRatioChange, onRatioCommit)
  const divider = document.createElement('div')
  divider.className = `divider divider-${node.dir}`
  divider.dataset.split = node.id

  a.style.flex = `${node.ratio} 1 0%`
  b.style.flex = `${1 - node.ratio} 1 0%`

  box.append(a, divider, b)

  let dragging = false
  divider.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    dragging = true
    divider.setPointerCapture(event.pointerId)
    document.body.classList.add(node.dir === 'row' ? 'resizing-x' : 'resizing-y')
    event.preventDefault()
  })

  divider.addEventListener('pointermove', (event) => {
    if (!dragging) return
    const rect = box.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return
    const ratio = node.dir === 'row'
      ? (event.clientX - rect.left) / rect.width
      : (event.clientY - rect.top) / rect.height
    const clamped = Math.min(0.92, Math.max(0.08, ratio))
    a.style.flex = `${clamped} 1 0%`
    b.style.flex = `${1 - clamped} 1 0%`
    onRatioChange(node.id, clamped)
  })

  const finish = (event) => {
    if (!dragging) return
    dragging = false
    try {
      divider.releasePointerCapture(event.pointerId)
    } catch {
      /* 指针已经释放 */
    }
    document.body.classList.remove('resizing-x', 'resizing-y')
    onRatioCommit()
  }
  divider.addEventListener('pointerup', finish)
  divider.addEventListener('pointercancel', finish)

  return box
}

export function groupSlotFor(container, groupId) {
  return container.querySelector(`.group-slot[data-group="${cssEscape(groupId)}"]`)
}

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value)
  return String(value).replace(/["\\]/g, '\\$&')
}
