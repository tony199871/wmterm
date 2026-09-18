import {
  collectLeaves,
  createLeaf,
  findLeaf,
  firstLeaf,
  neighborGroup,
  removeLeaf,
  replaceLeaf,
  splitLeaf,
  updateRatio,
} from './groups.js'
import { groupSlotFor, renderLayout } from './layout-view.js'
import { Pane } from './pane.js'
import { shortPath, relativeTime } from './util.js'

const SAVE_DEBOUNCE_MS = 350

/**
 * 分屏（Ctrl+Shift+D/E、右键菜单、标题栏按钮）打开新终端的方式：
 *   'tab'    在**同一个区域**里新增一个页签（默认）
 *   'window' 新开一个独立窗口
 *   'group'  在当前区域旁边再切一块新区域（分割线会连页签栏一起切开）
 */
const SPLIT_MODES = [
  { id: 'tab', label: '本区域新增页签', hint: '分屏时在同一区域里加页签' },
  { id: 'window', label: '新窗口', hint: '拆成独立窗口' },
  { id: 'group', label: '新区域（切开页签栏）', hint: '分割线贯穿整个窗口，两侧各一条页签栏' },
]

export class App {
  constructor(root) {
    this.root = root
    this.info = null
    this.shells = []
    this.defaultShellId = null
    this.splitMode = 'tab'

    /** 窗口级分屏树，叶子是区域 id */
    this.tree = null
    /** @type {Map<string, {id:string, tabs:string[], activeTabId:string|null, el:HTMLElement|null, tabsEl?:HTMLElement, termEl?:HTMLElement}>} */
    this.groups = new Map()
    /** @type {Map<string, Pane>} */
    this.panes = new Map()
    this.activeGroupId = null
    /** 「按路径打开」的历史记录，由主进程持久化 */
    this.recentPaths = []

    /** 阻止「新窗口」在还没加载完时把布局写回去 */
    this.canSave = false
    this.saveTimer = null
    this.notifyTimer = null
  }

  // ---------------------------------------------------------------- 启动

  async boot() {
    this.info = await window.multi.info()
    this.shells = this.info.shells || []
    this.settings = this.info.settings || {}
    // 用户在「默认终端」里选的优先，没选过或选项已失效则用自动探测的结果
    const wanted = this.settings.defaultShellId
    this.defaultShellId =
      (wanted && this.shells.some((s) => s.id === wanted) ? wanted : null) ||
      this.info.defaultShellId ||
      (this.shells[0] && this.shells[0].id) ||
      null
    window.__HOME__ = this.info.home

    this.buildShell()
    this.installShortcuts()
    this.installContextMenu()
    window.multi.onEvent((event) => this.onPtyEvent(event))
    window.addEventListener('resize', () => this.activePane?.scheduleFit())
    window.addEventListener('beforeunload', () => this.saveNow())

    const restored = this.info.fresh ? false : this.restoreSession()
    if (!restored) this.createGroup({ activate: true, initialTab: true, skipSave: true })
    this.canSave = !this.info.fresh
    this.updateStatus()
    // 历史记录异步补上，不阻塞启动
    this.loadPathHistory()
  }

  buildShell() {
    this.root.innerHTML = `
      <div class="app">
        <div class="layout" id="layout"></div>
        <div class="statusbar">
          <div class="status-left" id="status-left"></div>
          <div class="status-right" id="status-right"></div>
        </div>
      </div>
    `
    this.layoutEl = this.root.querySelector('#layout')
    this.statusLeft = this.root.querySelector('#status-left')
    this.statusRight = this.root.querySelector('#status-right')
  }

  shellLabel(shellId) {
    const shell = this.shells.find((s) => s.id === shellId)
    return shell ? shell.label : '终端'
  }

  // 默认终端（PowerShell / cmd / …）

  /** 页签栏上那个按钮显示当前默认终端 */
  renderShellButton(groupId = null) {
    if (!this.shellButtons) return
    const targets = groupId ? [this.shellButtons.get(groupId)] : [...this.shellButtons.values()]
    for (const button of targets) {
      if (!button) continue
      button.textContent = this.shellLabel(this.defaultShellId)
      button.title = `默认终端：${this.shellLabel(this.defaultShellId)}（点击切换 PowerShell / cmd）`
    }
  }

  /** 设置默认终端，写进设置文件，之后新建的页签都用它 */
  async setDefaultShell(shellId) {
    if (!this.shells.some((s) => s.id === shellId)) return
    this.defaultShellId = shellId
    this.settings = { ...(this.settings || {}), defaultShellId: shellId }
    this.renderShellButton()
    this.updateStatus()
    try {
      const saved = await window.multi.setSettings({ defaultShellId: shellId })
      this.settings = saved || this.settings
    } catch {
      this.flashStatus('默认终端没能写入设置文件')
      return
    }
    this.flashStatus(`默认终端：${this.shellLabel(shellId)}`)
  }

  showDefaultShellMenu(x, y) {
    const items = this.shells.map((shell) => ({
      label: `${shell.id === this.defaultShellId ? '● ' : '　'}${shell.label}`,
      shortcut: shell.file ? shell.file.split(/[\\/]/).pop() : '',
      run: () => this.setDefaultShell(shell.id),
    }))
    items.push({ separator: true })
    items.push({
      label: `立刻开一个 ${this.shellLabel(this.defaultShellId)} 页签`,
      shortcut: 'Ctrl+Shift+T',
      run: () => {
        if (this.activeGroup) this.addTab(this.activeGroup.id, { shellId: this.defaultShellId })
      },
    })
    items.push({
      label: '选择路径并打开终端…',
      shortcut: 'Ctrl+Shift+O',
      run: () => this.openPathDialog(),
    })
    this.openMenu(x, y, items)
  }

  // ---------------------------------------------------------------- 指定路径打开

  /** 历史记录：常用优先，其次最近使用 */
  pathHistory() {
    return Array.isArray(this.recentPaths) ? this.recentPaths : []
  }

  async loadPathHistory() {
    try {
      this.recentPaths = await window.multi.recentPaths()
    } catch {
      this.recentPaths = []
    }
    return this.pathHistory()
  }

  /** 在指定目录开一个新终端；group 为空时用当前区域 */
  async openAtPath(dir, { auto = false } = {}) {
    const target = String(dir || '').trim()
    if (!target) return null
    const check = await window.multi.checkPath(target)
    if (!check.ok) {
      this.flashStatus(`打不开：${check.reason}`)
      return null
    }
    const group = this.activeGroup
    if (!group) return null
    const pane = this.addTab(group.id, { shellId: this.defaultShellId, cwd: check.path })
    try {
      this.recentPaths = await window.multi.touchPath(check.path)
    } catch {
      /* 历史记录写失败不影响开终端 */
    }
    if (!auto) this.flashStatus(`已在 ${shortPath(check.path, 40)} 打开终端`)
    return pane
  }

  /** 当前终端的工作目录（新建终端时用的就是它） */
  activeCwd() {
    const pane = this.activePane
    return pane?.cwd || this.info?.cwd || null
  }

  showPathHistoryMenu(x, y) {
    const history = this.pathHistory()
    const activeCwd = this.activeCwd()
    const items = [
      { label: '选择路径并打开终端…', shortcut: 'Ctrl+Shift+O', run: () => this.openPathDialog() },
    ]
    if (activeCwd) {
      items.push({
        label: `在「${shortPath(activeCwd, 34)}」打开新页签`,
        run: () => this.openAtPath(activeCwd),
      })
    }
    items.push({ separator: true })
    if (history.length === 0) {
      items.push({ label: '（还没有历史记录）', disabled: true, run: () => {} })
    } else {
      for (const entry of history.slice(0, 12)) {
        items.push({
          label: `${entry.exists ? '　' : '✕ '}${shortPath(entry.path, 40)}`,
          shortcut: entry.count > 1 ? `用过 ${entry.count} 次` : '',
          run: () => this.openAtPath(entry.path),
        })
      }
    }
    this.openMenu(x, y, items)
  }

  /** 路径选择弹窗：输入框 + 浏览按钮 + 历史列表 */
  openPathDialog() {
    if (this.pathDialogEl && !this.pathDialogEl.hidden) return
    this.closePathDialog()

    const overlay = document.createElement('div')
    overlay.className = 'dialog-overlay'

    const box = document.createElement('div')
    box.className = 'dialog'

    const title = document.createElement('div')
    title.className = 'dialog-title'
    title.textContent = '在指定路径打开终端'

    const row = document.createElement('div')
    row.className = 'dialog-row'

    const input = document.createElement('input')
    input.className = 'dialog-input'
    input.type = 'text'
    input.placeholder = '输入或粘贴目录路径，例如 D:\\work\\code'
    input.spellcheck = false
    input.value = this.activeCwd() || ''

    const browse = document.createElement('button')
    browse.type = 'button'
    browse.className = 'dialog-btn'
    browse.textContent = '浏览…'
    browse.addEventListener('click', async () => {
      const picked = await window.multi.pickDirectory()
      if (picked) {
        input.value = picked
        hint.textContent = ''
        input.focus()
      }
    })

    const useCurrent = document.createElement('button')
    useCurrent.type = 'button'
    useCurrent.className = 'dialog-btn'
    useCurrent.textContent = '当前终端目录'
    useCurrent.addEventListener('click', () => {
      input.value = this.activeCwd() || ''
      input.focus()
    })

    row.append(input, browse, useCurrent)

    const hint = document.createElement('div')
    hint.className = 'dialog-hint'
    hint.textContent = 'Enter 打开 · Esc 取消'

    const historyBox = document.createElement('div')
    historyBox.className = 'dialog-history'

    const footer = document.createElement('div')
    footer.className = 'dialog-footer'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'dialog-btn'
    cancel.textContent = '取消'
    cancel.addEventListener('click', () => this.closePathDialog())
    const confirm = document.createElement('button')
    confirm.type = 'button'
    confirm.className = 'dialog-btn dialog-btn-primary'
    confirm.textContent = '打开'
    confirm.addEventListener('click', () => {
      const value = input.value.trim()
      if (!value) {
        hint.textContent = '请先填一个路径'
        return
      }
      this.closePathDialog()
      this.openAtPath(value)
    })
    footer.append(hint, cancel, confirm)

    box.append(title, row, historyBox, footer)
    overlay.appendChild(box)
    document.body.appendChild(overlay)
    this.pathDialogEl = overlay

    const onSubmit = (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        confirm.click()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        this.closePathDialog()
      }
    }
    input.addEventListener('keydown', onSubmit)
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) this.closePathDialog()
    })

    this.renderPathHistory(historyBox, input, hint)
    this.loadPathHistory().then(() => {
      if (this.pathDialogEl === overlay) this.renderPathHistory(historyBox, input, hint)
    })

    input.focus()
    input.select()
  }

  renderPathHistory(container, input, hint) {
    container.textContent = ''
    const history = this.pathHistory()
    if (history.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'dialog-empty'
      empty.textContent = '还没有历史记录。打开一次之后，这里就能直接点。'
      container.appendChild(empty)
      return
    }
    for (const entry of history) {
      const item = document.createElement('div')
      item.className = `dialog-item${entry.exists ? '' : ' is-missing'}`
      item.title = entry.exists ? entry.path : `${entry.path}（目录已不存在）`

      const label = document.createElement('span')
      label.className = 'dialog-item-path'
      label.textContent = shortPath(entry.path, 58)

      const meta = document.createElement('span')
      meta.className = 'dialog-item-meta'
      meta.textContent = entry.exists
        ? `${entry.count} 次${entry.at ? ` · ${relativeTime(entry.at)}` : ''}`
        : '目录不存在'

      const forget = document.createElement('button')
      forget.type = 'button'
      forget.className = 'dialog-item-forget'
      forget.title = '从历史记录里删掉'
      forget.addEventListener('click', async (event) => {
        event.stopPropagation()
        this.recentPaths = await window.multi.forgetPath(entry.path)
        this.renderPathHistory(container, input, hint)
      })

      item.append(label, meta, forget)
      item.addEventListener('click', () => {
        if (!entry.exists) {
          hint.textContent = '这个目录已经不存在了'
          return
        }
        this.closePathDialog()
        this.openAtPath(entry.path)
      })
      item.addEventListener('mouseenter', () => {
        input.value = entry.path
      })
      container.appendChild(item)
    }
  }

  closePathDialog() {
    this.pathDialogEl?.remove()
    this.pathDialogEl = null
  }

  // ---------------------------------------------------------------- 区域

  get activeGroup() {
    return this.groups.get(this.activeGroupId) || null
  }

  get activePane() {
    const group = this.activeGroup
    if (!group || !group.activeTabId) return null
    return this.panes.get(group.activeTabId) || null
  }

  createGroup({ activate = true, initialTab = true, shellId = null, cwd = null, skipSave = false, groupId = null } = {}) {
    const id = groupId || `g-${Math.random().toString(36).slice(2, 9)}`
    const group = { id, tabs: [], activeTabId: null, el: null, tabsEl: null }
    this.groups.set(id, group)
    this.tree = this.tree ? splitLeaf(this.tree, this.activeGroupId, 'row', id) : createLeaf(id)
    this.renderTree()
    if (initialTab) {
      this.addTab(id, { shellId: shellId || this.defaultShellId, cwd })
    }
    if (activate) this.setActiveGroup(id)
    if (!skipSave) this.scheduleSave()
    return group
  }

  /** 在当前区域右侧再切一块新区域出来，分割线贯穿整个窗口 */
  openGroup(paneId, dir = 'row') {
    const source = this.paneFor(paneId) ? this.groupOfPane(paneId) : this.activeGroup
    if (!source) return null
    const newGroupId = `g-${Math.random().toString(36).slice(2, 9)}`
    const newGroup = {
      id: newGroupId,
      tabs: [],
      activeTabId: null,
      el: null,
      tabsEl: null,
    }
    this.groups.set(newGroupId, newGroup)
    this.tree = splitLeaf(this.tree, source.id, dir, newGroupId)
    const pane = this.spawnPane(newGroupId, { shellId: this.defaultShellId })
    this.renderTree()
    this.setActiveGroup(newGroupId)
    this.flashStatus(`已切出新区域 · ${this.shellLabel(pane?.shellId)}`)
    this.scheduleSave()
    return newGroup
  }

  closeGroup(groupId) {
    const group = this.groups.get(groupId)
    if (!group) return
    if (this.groups.size <= 1) {
      // 最后一个区域：清掉它的页签再补一个新的空页签
      this.disposeGroupTabs(group)
      this.addTab(groupId, { shellId: this.defaultShellId })
      this.scheduleSave()
      return
    }

    const leaves = collectLeaves(this.tree)
    const index = leaves.findIndex((l) => l.groupId === groupId)
    const heirId = (leaves[index + 1] || leaves[index - 1] || {}).groupId
    const heir = heirId ? this.groups.get(heirId) : null
    const orphans = [...group.tabs]

    const { root, removed } = removeLeaf(this.tree, groupId)
    if (!removed) return
    this.tree = root

    group.tabs = []
    group.activeTabId = null
    this.groups.delete(groupId)

    // 把它的页签交给邻居区域，终端不会被杀掉
    if (heir) {
      for (const paneId of orphans) heir.tabs.push(paneId)
      if (!heir.activeTabId) heir.activeTabId = orphans[0] || null
    } else {
      for (const paneId of orphans) this.disposePane(paneId)
    }

    // 塌缩后树可能整个空掉，这时用剩下的区域重建一棵
    if (!this.tree) {
      const remaining = [...this.groups.keys()]
      this.tree = remaining.length ? firstPlaceholder(this.groups) : null
    }

    this.renderTree()
    if (!heir || heir.tabs.length === 0) {
      const target = heir || this.groups.values().next().value
      if (target) this.addTab(target.id, { shellId: this.defaultShellId })
    }
    const nextActive = heir ? heir.id : firstLeaf(this.tree)?.groupId
    this.renderTree()
    if (nextActive) this.setActiveGroup(nextActive)
    this.flashStatus('已关闭区域' + (orphans.length ? `，${orphans.length} 个终端已并入相邻区域` : ''))
    this.scheduleSave()
  }

  disposeGroupTabs(group) {
    for (const paneId of [...group.tabs]) this.disposePane(paneId)
    group.tabs = []
    group.activeTabId = null
  }

  setActiveGroup(groupId) {
    if (!this.groups.has(groupId)) return
    this.activeGroupId = groupId
    for (const [id, group] of this.groups) {
      group.el?.classList.toggle('is-active', id === groupId)
    }
    const group = this.groups.get(groupId)
    if (group && !group.activeTabId && group.tabs.length) group.activeTabId = group.tabs[0]
    for (const pane of this.panes.values()) pane.setActive(pane.paneId === group?.activeTabId)
    this.activePane?.focus()
    this.updateStatus()
  }

  moveFocus(dir) {
    if (!this.tree || !this.activeGroupId) return
    const target = neighborGroup(this.tree, this.activeGroupId, dir)
    if (target) this.setActiveGroup(target)
  }
  cycleGroup(step) {
    const leaves = collectLeaves(this.tree)
    if (leaves.length < 2) return
    const index = leaves.findIndex((l) => l.groupId === this.activeGroupId)
    const next = leaves[(index + step + leaves.length) % leaves.length]
    if (next) this.setActiveGroup(next.groupId)
  }

  // ---------------------------------------------------------------- 页签

  groupOfPane(paneId) {
    for (const group of this.groups.values()) {
      if (group.tabs.includes(paneId)) return group
    }
    return null
  }

  paneFor(paneId) {
    if (!paneId) return this.activePane
    return this.panes.get(paneId) || null
  }

  /** 在指定区域里新建一个页签 */
  addTab(groupId, { shellId = null, cwd = null, tabId = null, title = null, activate = true, skipSave = false } = {}) {
    const group = this.groups.get(groupId)
    if (!group) return null
    const pane = this.spawnPane(groupId, { shellId: shellId || this.defaultShellId, cwd, tabId, title })
    if (activate) this.activateTab(groupId, pane.paneId)
    else {
      this.renderGroupTabBar(group)
      this.scheduleSave()
    }
    if (skipSave) return pane
    return pane
  }

  activateTab(groupId, paneId) {
    const group = this.groups.get(groupId)
    if (!group || !group.tabs.includes(paneId)) return
    group.activeTabId = paneId
    this.renderGroupTabBar(group)
    this.renderGroupBody(group)
    this.setActiveGroup(groupId)
    this.scheduleSave()
  }

  closeTab(groupId, paneId) {
    const group = this.groups.get(groupId)
    if (!group) return
    const index = group.tabs.indexOf(paneId)
    if (index < 0) return
    group.tabs.splice(index, 1)
    this.disposePane(paneId)

    if (group.tabs.length === 0) {
      if (this.groups.size <= 1) {
        // 最后一个区域不能空着，补一个新页签
        this.spawnPane(groupId, { shellId: this.defaultShellId })
        this.renderGroup(group)
        this.scheduleSave()
        return
      }
      this.closeGroup(groupId)
      return
    }

    if (group.activeTabId === paneId) {
      group.activeTabId = group.tabs[Math.min(index, group.tabs.length - 1)]
    }
    this.renderGroup(group)
    this.updateStatus()
    this.scheduleSave()
  }

  cycleTab(step) {
    const group = this.activeGroup
    if (!group || group.tabs.length < 2) return
    const index = group.tabs.indexOf(group.activeTabId)
    const next = group.tabs[(index + step + group.tabs.length) % group.tabs.length]
    if (next) this.activateTab(group.id, next)
  }

  /** 依次聚焦下一个区域里的下一个页签，用于快速轮巡所有终端 */
  focusNextAttention() {
    const leaves = collectLeaves(this.tree)
    if (leaves.length < 2) return
    const index = leaves.findIndex((l) => l.groupId === this.activeGroupId)
    const nextLeaf = leaves[(index + 1) % leaves.length]
    const next = nextLeaf && this.groups.get(nextLeaf.groupId)
    if (!next) return
    this.setActiveGroup(next.id)
    if (next.tabs.length > 1) {
      const tabIndex = next.tabs.indexOf(next.activeTabId)
      const nextTab = next.tabs[(tabIndex + 1) % next.tabs.length]
      if (nextTab) this.activateTab(next.id, nextTab)
    }
  }

  // ---------------------------------------------------------------- 窗格

  spawnPane(groupId, { shellId = null, cwd = null, tabId = null, title = null } = {}) {
    const group = this.groups.get(groupId)
    if (!group) return null
    const id = tabId || `pane-${Math.random().toString(36).slice(2, 9)}`
    const resolvedShell = shellId || this.defaultShellId
    const pane = new Pane(this, id, {
      shellId: resolvedShell,
      cwd,
      title: title || this.shellLabel(resolvedShell),
    })
    this.panes.set(id, pane)
    group.tabs.push(id)
    group.activeTabId = id
    pane.__groupId = groupId
    this.renderGroup(group)
    this.scheduleSave()
    return pane
  }

  disposePane(paneId) {
    const pane = this.panes.get(paneId)
    if (!pane) return
    this.panes.delete(paneId)
    pane.dispose()
  }

  setActivePane(paneId) {
    const group = this.groupOfPane(paneId)
    if (!group) return
    group.activeTabId = paneId
    this.renderGroupTabBar(group)
    this.renderGroupBody(group)
    this.setActiveGroup(group.id)
  }

  /**
   * 统一的「再开一个终端」入口，按当前 splitMode 决定：
   * 本区域加页签 / 新窗口 / 切出新区域
   */
  duplicatePane(paneId, dir = 'row', options = {}) {
    const source = this.paneFor(paneId)
    const mode = options.mode || this.splitMode
    const shellId = options.shellId || source?.shellId || this.defaultShellId
    const cwd = options.cwd || source?.cwd || null

    if (mode === 'window') {
      window.multi.openWindow().catch(() => this.flashStatus('无法打开新窗口'))
      return null
    }
    if (mode === 'group') {
      return this.openGroup(paneId, dir)
    }
    const group = this.groupOfPane(paneId) || this.activeGroup
    if (!group) return null
    return this.addTab(group.id, { shellId, cwd })
  }

  /** 不管分屏方式，强制在当前区域里再切一块区域出来 */
  splitIntoNewGroup(paneId, dir = 'row') {
    return this.openGroup(paneId, dir)
  }

  setSplitMode(mode) {
    if (!SPLIT_MODES.some((m) => m.id === mode)) return
    this.splitMode = mode
    this.scheduleSave()
    const entry = SPLIT_MODES.find((m) => m.id === mode)
    this.flashStatus(`分屏方式：${entry.label}`)
    this.updateStatus()
  }

  // ---------------------------------------------------------------- 渲染

  renderTree() {
    renderLayout(this.layoutEl, this.tree, {
      renderLeaf: (groupId) => this.buildGroupElement(groupId),
      onRatioChange: (splitId, ratio) => {
        this.tree = updateRatio(this.tree, splitId, ratio)
      },
      onRatioCommit: () => {
        for (const pane of this.panes.values()) pane.scheduleFit()
        this.scheduleSave()
      },
    })
    for (const group of this.groups.values()) {
      group.el = groupSlotFor(this.layoutEl, group.id)?.querySelector('.group') || null
      this.renderGroup(group)
    }
    for (const [id, group] of this.groups) {
      group.el?.classList.toggle('is-active', id === this.activeGroupId)
    }
  }

  buildGroupElement(groupId) {
    const group = this.groups.get(groupId)
    const el = document.createElement('div')
    el.className = 'group'
    el.dataset.group = groupId

    const tabbar = document.createElement('div')
    tabbar.className = 'group-tabbar'

    const tabs = document.createElement('div')
    tabs.className = 'group-tabs'

    const actions = document.createElement('div')
    actions.className = 'group-tabbar-actions'

    // 默认终端：点一下切换 PowerShell / cmd，新的页签都用它
    const shellButton = document.createElement('button')
    shellButton.className = 'shell-picker'
    shellButton.type = 'button'
    shellButton.addEventListener('click', (event) => {
      event.stopPropagation()
      this.setActiveGroup(groupId)
      const rect = event.currentTarget.getBoundingClientRect()
      this.showDefaultShellMenu(rect.right - 260, rect.bottom + 4)
    })

    const addButton = document.createElement('button')
    addButton.className = 'icon-btn'
    addButton.type = 'button'
    addButton.title = '在此区域新建页签 (Ctrl+Shift+T)'
    addButton.innerHTML = '<span class="glyph-plus"></span>'
    addButton.addEventListener('click', (event) => {
      event.stopPropagation()
      this.addTab(groupId, { shellId: this.defaultShellId })
    })

    // 按路径打开：历史记录里点一下就开，不用手动 cd
    const pathButton = document.createElement('button')
    pathButton.className = 'icon-btn icon-folder'
    pathButton.type = 'button'
    pathButton.title = '按路径打开终端（含历史记录，Ctrl+Shift+O）'
    pathButton.addEventListener('click', (event) => {
      event.stopPropagation()
      this.setActiveGroup(groupId)
      const rect = event.currentTarget.getBoundingClientRect()
      this.showPathHistoryMenu(rect.right - 260, rect.bottom + 4)
    })

    const modeButton = document.createElement('button')
    modeButton.className = 'icon-btn icon-splitmode'
    modeButton.type = 'button'
    modeButton.title = '分屏方式'
    modeButton.addEventListener('click', (event) => {
      event.stopPropagation()
      const rect = event.currentTarget.getBoundingClientRect()
      this.showSplitModeMenu(rect.right - 240, rect.bottom + 4, groupId)
    })
    actions.append(shellButton, addButton, pathButton, modeButton)
    tabbar.append(tabs, actions)
    this.shellButtons = this.shellButtons || new Map()
    this.shellButtons.set(groupId, shellButton)
    this.renderShellButton(groupId)

    const term = document.createElement('div')
    term.className = 'group-term'

    el.append(tabbar, term)
    if (group) {
      group.tabsEl = tabs
      group.termEl = term
      group.actionsEl = actions
    }
    el.addEventListener('mousedown', () => {
      if (this.activeGroupId !== groupId) this.setActiveGroup(groupId)
    }, true)
    return el
  }

  renderGroup(group) {
    if (!group.el) {
      group.el = groupSlotFor(this.layoutEl, group.id)?.querySelector('.group') || null
      if (group.el) {
        group.tabsEl = group.el.querySelector('.group-tabs')
        group.termEl = group.el.querySelector('.group-term')
      }
    }
    this.renderGroupTabBar(group)
    this.renderGroupBody(group)
  }

  renderGroupTabBar(group) {
    const container = group.tabsEl
    if (!container) return
    container.textContent = ''
    for (const paneId of group.tabs) {
      const pane = this.panes.get(paneId)
      if (!pane) continue
      const button = document.createElement('div')
      button.className = `tab${paneId === group.activeTabId ? ' is-active' : ''}${pane.needsAttention ? ' needs-attention' : ''}${pane.exited ? ' is-exited' : ''}`
      button.dataset.pane = paneId
      button.title = pane.exited
        ? `${pane.title}（已退出，按 Enter 重启）`
        : pane.title || this.shellLabel(pane.shellId)

      const label = document.createElement('span')
      label.className = 'tab-label'
      label.textContent = pane.title || this.shellLabel(pane.shellId)

      const close = document.createElement('button')
      close.className = 'tab-close'
      close.type = 'button'
      close.title = '关闭这个页签 (Ctrl+Shift+W)'
      close.addEventListener('click', (event) => {
        event.stopPropagation()
        this.closeTab(group.id, paneId)
      })

      button.append(label, close)
      button.addEventListener('click', () => this.activateTab(group.id, paneId))
      button.addEventListener('auxclick', (event) => {
        if (event.button === 1) this.closeTab(group.id, paneId)
      })
      container.appendChild(button)
    }
  }

  renderGroupBody(group) {
    const body = group.termEl
    if (!body) return
    const paneId = group.activeTabId
    const pane = paneId ? this.panes.get(paneId) : null
    if (!pane) {
      body.textContent = ''
      return
    }
    // 同一个 xterm 实例在区域之间搬动时只移动 DOM 节点，不重建终端
    if (pane.element && pane.element.parentElement === body) return
    body.textContent = ''
    const slot = document.createElement('div')
    slot.className = 'pane-slot'
    slot.dataset.pane = paneId
    body.appendChild(slot)
    // 页签第一次被切到才真正起终端，恢复出来的布局不会一次性 spawn 一堆进程
    pane.mount(slot)
  }

  // ---------------------------------------------------------------- 事件

  registerSession(sessionId, pane) {
    this.sessions = this.sessions || new Map()
    this.sessions.set(sessionId, pane)
  }

  paneForSession(sessionId) {
    if (this.sessions?.has(sessionId)) return this.sessions.get(sessionId)
    for (const pane of this.panes.values()) if (pane.sessionId === sessionId) return pane
    return null
  }

  onPtyEvent(event) {
    if (!event || !event.id) return
    if (event.type === 'data') {
      const pane = this.paneForSession(event.id)
      if (pane) pane.writeChunk(event.b64)
      return
    }
    if (event.type === 'exit') {
      const pane = this.paneForSession(event.id)
      if (pane) pane.onExit(event.code)
      this.updateStatus()
    }
  }

  onPaneTitle(pane) {
    const group = this.groupOfPane(pane.paneId)
    if (group) this.renderGroupTabBar(group)
    if (pane === this.activePane) this.updateStatus()
  }

  onBell(pane) {
    const group = this.groupOfPane(pane.paneId)
    if (!group) return
    pane.needsAttention = true
    if (group.id === this.activeGroupId) pane.needsAttention = false
    this.renderGroupTabBar(group)
  }

  /** 终端进程退出 / 重启后刷新页签上的状态标记 */
  onPaneStateChange(pane) {
    const group = this.groupOfPane(pane.paneId)
    if (group) this.renderGroupTabBar(group)
    if (pane === this.activePane) this.updateStatus()
  }

  // ---------------------------------------------------------------- 状态栏

  updateStatus() {
    const pane = this.activePane
    const group = this.activeGroup
    this.statusLeft.innerHTML = ''
    this.statusRight.innerHTML = ''

    if (!pane || !group) {
      this.statusLeft.textContent = ''
      this.statusRight.textContent = ''
      return
    }

    const leaves = collectLeaves(this.tree)
    const groupIndex = leaves.findIndex((l) => l.groupId === group.id) + 1
    const tabIndex = group.tabs.indexOf(group.activeTabId) + 1
    const size = pane.term ? `${pane.term.cols}×${pane.term.rows}` : ''

    const left = document.createElement('span')
    const regionPart = leaves.length > 1 ? `区域 ${groupIndex}/${leaves.length} · ` : ''
    left.textContent = `${regionPart}${this.shellLabel(pane.shellId)} · 页签 ${tabIndex}/${group.tabs.length}${size ? ` · ${size}` : ''}`
    this.statusLeft.appendChild(left)

    const mode = SPLIT_MODES.find((m) => m.id === this.splitMode)
    const modeChip = document.createElement('button')
    modeChip.type = 'button'
    modeChip.className = 'status-chip'
    modeChip.textContent = `分屏 → ${mode ? mode.label : this.splitMode}`
    modeChip.title = '点击循环切换：本区域加页签 / 新窗口 / 切出新区域'
    modeChip.addEventListener('click', () => {
      const order = SPLIT_MODES.map((m) => m.id)
      this.setSplitMode(order[(order.indexOf(this.splitMode) + 1) % order.length])
    })
    this.statusLeft.appendChild(modeChip)

    if (leaves.length > 1) {
      const closeRegion = document.createElement('button')
      closeRegion.type = 'button'
      closeRegion.className = 'status-chip'
      closeRegion.textContent = '关闭本区域'
      closeRegion.title = '关掉这个区域，它的页签会并入相邻区域'
      closeRegion.addEventListener('click', () => this.closeGroup(group.id))
      this.statusLeft.appendChild(closeRegion)
    }

    const shellChip = document.createElement('button')
    shellChip.type = 'button'
    shellChip.className = 'status-chip'
    shellChip.textContent = `默认终端：${this.shellLabel(this.defaultShellId)}`
    shellChip.title = '点击切换默认终端（新建页签用它：PowerShell / cmd / …）'
    shellChip.addEventListener('click', (event) => {
      const rect = event.currentTarget.getBoundingClientRect()
      this.showDefaultShellMenu(rect.left, rect.top - 8)
    })
    this.statusLeft.appendChild(shellChip)

    const cwd = document.createElement('span')
    cwd.textContent = shortPath(pane.cwd || this.info?.cwd || '', 46)
    cwd.title = pane.cwd || ''
    const hint = document.createElement('span')
    hint.className = 'hint'
    hint.textContent = leaves.length > 1
      ? 'Ctrl+Shift+D 开新终端 · Alt+方向键 切区域 · Ctrl+Tab 切页签'
      : 'Ctrl+Shift+D 开新终端 · Ctrl+Shift+E 切出新区域 · Ctrl+Tab 切页签'
    this.statusRight.append(cwd, hint)
  }

  // ---------------------------------------------------------------- 快捷键

  installShortcuts() {
    window.addEventListener(
      'keydown',
      (event) => {
        const pane = this.activePane
        if (pane?.handleKey(event)) {
          event.preventDefault()
          return
        }

        const mod = event.ctrlKey || event.metaKey
        const shift = event.shiftKey
        const key = event.key
        const lower = key.length === 1 ? key.toLowerCase() : key

        // Alt + 方向键：在区域之间移动焦点
        if (event.altKey && !mod) {
          const dir = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[key]
          if (dir) {
            event.preventDefault()
            if (collectLeaves(this.tree).length > 1) this.moveFocus(dir)
            else if (dir === 'left' || dir === 'right') this.cycleTab(dir === 'left' ? -1 : 1)
            return
          }
        }

        // Ctrl+Tab / Ctrl+Shift+Tab：在**当前区域**里切换页签
        if (mod && key === 'Tab') {
          event.preventDefault()
          this.cycleTab(shift ? -1 : 1)
          return
        }

        if (!mod || !shift) return

        switch (lower) {
          case 't':
            event.preventDefault()
            if (this.activeGroup) this.addTab(this.activeGroup.id, { shellId: this.defaultShellId })
            break
          case 'w':
            event.preventDefault()
            if (this.activeGroup?.activeTabId) this.closeTab(this.activeGroup.id, this.activeGroup.activeTabId)
            break
          case 'd':
            event.preventDefault()
            if (pane) this.duplicatePane(pane.paneId, 'row')
            break
          case 'e':
            event.preventDefault()
            if (pane) this.splitIntoNewGroup(pane.paneId, 'col')
            break
          case 'x':
            event.preventDefault()
            if (this.activeGroup?.activeTabId) this.closeTab(this.activeGroup.id, this.activeGroup.activeTabId)
            break
          case 'q':
            event.preventDefault()
            if (this.activeGroup) this.closeGroup(this.activeGroup.id)
            break
          case 'n':
            event.preventDefault()
            this.cycleGroup(1)
            break
          case 'p':
            event.preventDefault()
            this.focusNextAttention()
            break
          case 'c':
            event.preventDefault()
            this.copySelection()
            break
          case 'v':
            event.preventDefault()
            this.paste()
            break
          case 'k':
            event.preventDefault()
            pane?.term?.clear()
            break
          case 'f':
            event.preventDefault()
            this.toggleFullscreen()
            break
          case 's':
            event.preventDefault()
            this.saveNow()
            this.flashStatus('布局已保存')
            break
          case 'o':
            event.preventDefault()
            this.openPathDialog()
            break
          case 'arrowleft':
          case 'arrowright':
          case 'arrowup':
          case 'arrowdown': {
            event.preventDefault()
            const dir = { arrowleft: 'left', arrowright: 'right', arrowup: 'up', arrowdown: 'down' }[lower]
            if (collectLeaves(this.tree).length > 1) this.moveFocus(dir)
            break
          }
          default:
            break
        }
      },
      true,
    )
  }

  copySelection() {
    const pane = this.activePane
    const text = pane?.term?.getSelection()
    if (text) {
      navigator.clipboard.writeText(text).catch(() => {})
      this.flashStatus('已复制')
    } else {
      this.flashStatus('没有选中内容')
    }
  }

  async paste() {
    const pane = this.activePane
    if (!pane || pane.exited) return
    try {
      const text = await navigator.clipboard.readText()
      if (text) pane.term.paste(text)
    } catch {
      this.flashStatus('无法读取剪贴板')
    }
  }

  toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen()
    else document.documentElement.requestFullscreen?.().catch(() => {})
  }

  flashStatus(text) {
    if (!this.statusRight) return
    const span = document.createElement('span')
    span.className = 'flash'
    span.textContent = text
    this.statusRight.appendChild(span)
    clearTimeout(this.notifyTimer)
    this.notifyTimer = setTimeout(() => span.remove(), 1800)
  }

  // ---------------------------------------------------------------- 右键菜单

  installContextMenu() {
    this.menuEl = document.createElement('div')
    this.menuEl.className = 'menu'
    this.menuEl.hidden = true
    document.body.appendChild(this.menuEl)

    const close = () => {
      this.menuEl.hidden = true
      this.menuEl.textContent = ''
    }
    document.addEventListener('mousedown', (event) => {
      if (!this.menuEl.hidden && !this.menuEl.contains(event.target)) close()
    })
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') close()
    })

    this.layoutEl.addEventListener('contextmenu', (event) => {
      const slot = event.target.closest?.('.pane-slot')
      if (!slot) return
      event.preventDefault()
      const paneId = slot.dataset.pane
      const pane = this.panes.get(paneId)
      const group = this.groupOfPane(paneId)
      if (!pane || !group) return
      this.setActivePane(paneId)
      const hasSelection = !!(pane.term?.getSelection() || '').length

      this.openMenu(event.clientX, event.clientY, [
        { label: '复制', shortcut: 'Ctrl+Shift+C', disabled: !hasSelection, run: () => this.copySelection() },
        { label: '粘贴', shortcut: 'Ctrl+Shift+V', run: () => this.paste() },
        { separator: true },
        { label: '本区域新增页签', shortcut: 'Ctrl+Shift+D', run: () => this.duplicatePane(paneId, 'row') },
        { label: '选择路径并打开终端…', shortcut: 'Ctrl+Shift+O', run: () => this.openPathDialog() },
        { label: '从历史路径打开', run: () => {
          const rect = this.layoutEl.getBoundingClientRect()
          this.showPathHistoryMenu(rect.left + 40, rect.top + 40)
        } },
        {
          label: '新开一个独立窗口',
          run: () => window.multi.openWindow().catch(() => this.flashStatus('无法打开新窗口')),
        },
        { separator: true },
        { label: '向右切出新区域', shortcut: 'Ctrl+Shift+E', run: () => this.openGroup(paneId, 'row') },
        { label: '向下切出新区域', run: () => this.openGroup(paneId, 'col') },
        ...(this.groups.size > 1
          ? [{ label: '关闭本区域（页签并入相邻区域）', shortcut: 'Ctrl+Shift+Q', run: () => this.closeGroup(group.id) }]
          : []),
        { separator: true },
        ...this.shells
          .filter((shell) => shell.id !== this.defaultShellId)
          .map((shell) => ({
            label: `把「${shell.label}」设为默认终端`,
            run: () => this.setDefaultShell(shell.id),
          })),
        { label: `用默认终端（${this.shellLabel(this.defaultShellId)}）新建页签`, shortcut: 'Ctrl+Shift+T', run: () => this.addTab(group.id, { shellId: this.defaultShellId }) },
        { separator: true },
        { label: '清屏', shortcut: 'Ctrl+Shift+K', run: () => pane.term?.clear() },
        {
          label: pane.exited ? '重新启动终端' : '关闭页签',
          shortcut: 'Ctrl+Shift+W',
          run: () => (pane.exited ? pane.restart() : this.closeTab(group.id, paneId)),
        },
      ])
    })
  }

  openMenu(x, y, items) {
    this.menuEl.textContent = ''
    for (const item of items) {
      if (item.separator) {
        const sep = document.createElement('div')
        sep.className = 'menu-sep'
        this.menuEl.appendChild(sep)
        continue
      }
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'menu-item'
      row.disabled = !!item.disabled
      const label = document.createElement('span')
      label.textContent = item.label
      row.appendChild(label)
      if (item.shortcut) {
        const kbd = document.createElement('span')
        kbd.className = 'menu-kbd'
        kbd.textContent = item.shortcut
        row.appendChild(kbd)
      }
      row.addEventListener('click', () => {
        this.menuEl.hidden = true
        item.run()
      })
      this.menuEl.appendChild(row)
    }
    this.menuEl.hidden = false
    const rect = this.menuEl.getBoundingClientRect()
    const left = Math.min(x, window.innerWidth - rect.width - 8)
    const top = Math.min(y, window.innerHeight - rect.height - 8)
    this.menuEl.style.left = `${Math.max(4, left)}px`
    this.menuEl.style.top = `${Math.max(4, top)}px`
  }

  showSplitModeMenu(x, y, groupId = null) {
    const items = SPLIT_MODES.map((mode) => ({
      label: `${mode.id === this.splitMode ? '● ' : '　'}${mode.label}`,
      shortcut: mode.hint,
      run: () => this.setSplitMode(mode.id),
    }))
    items.push({ separator: true })
    items.push({
      label: '现在就新开一个终端',
      shortcut: 'Ctrl+Shift+D',
      run: () => {
        const pane = this.activePane
        if (pane) this.duplicatePane(pane.paneId, 'row')
      },
    })
    items.push({
      label: '立刻切出新区域',
      shortcut: 'Ctrl+Shift+E',
      run: () => {
        const pane = this.activePane
        if (pane) this.splitIntoNewGroup(pane.paneId, 'row')
        else if (groupId) this.openGroup(null, 'row')
      },
    })
    this.openMenu(x, y, items)
  }

  // ---------------------------------------------------------------- 持久化

  scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.saveNow(), SAVE_DEBOUNCE_MS)
  }

  saveNow() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (!window.multi) return
    if (!this.canSave || this.info?.fresh) return
    window.multi.saveSession(this.serialize()).catch(() => {})
  }

  serialize() {
    return {
      splitMode: this.splitMode,
      activeGroupId: this.activeGroupId,
      tree: this.tree,
      groups: [...this.groups.values()].map((group) => ({
        id: group.id,
        tabs: [...group.tabs],
        activeTabId: group.activeTabId,
      })),
      panes: [...this.panes.values()].map((pane) => ({ paneId: pane.paneId, ...pane.serialize() })),
    }
  }

  restoreSession() {
    const saved = this.info?.session
    if (!saved) return false
    if (SPLIT_MODES.some((m) => m.id === saved.splitMode)) this.splitMode = saved.splitMode
    try {
      if (Array.isArray(saved.groups) && saved.tree) return this.restoreGroups(saved)
      if (Array.isArray(saved.tabs)) return this.restoreLegacyTabs(saved)
      return false
    } catch {
      for (const group of this.groups.values()) this.disposeGroupTabs(group)
      this.groups.clear()
      this.panes.clear()
      this.tree = null
      this.activeGroupId = null
      return false
    }
  }

  restoreGroups(saved) {
    const paneSpecs = new Map((saved.panes || []).map((p) => [p.paneId, p]))
    let used = 0
    for (const spec of saved.groups) {
      if (!spec || !spec.id) continue
      const tabs = (spec.tabs || []).filter((id) => paneSpecs.has(id))
      if (tabs.length === 0) continue
      const group = {
        id: spec.id,
        tabs: [],
        activeTabId: null,
        el: null,
        tabsEl: null,
      }
      this.groups.set(group.id, group)
      this.tree = this.tree ? splitLeaf(this.tree, this.activeGroupId, 'row', group.id) : createLeaf(group.id)
      for (const paneId of tabs) {
        const info = paneSpecs.get(paneId)
        const pane = new Pane(this, paneId, {
          shellId: info.shellId || this.defaultShellId,
          cwd: info.cwd || null,
          title: info.title,
        })
        pane.__groupId = group.id
        this.panes.set(paneId, pane)
        group.tabs.push(paneId)
      }
      group.activeTabId = tabs.includes(spec.activeTabId) ? spec.activeTabId : tabs[0]
      used += 1
    }
    if (used === 0) return false

    // 用保存下来的树覆盖临时拼出来的顺序，丢掉指向不存在区域的节点
    const pruned = sanitizeTree(saved.tree, this.groups)
    this.tree = pruned || firstPlaceholder(this.groups)
    this.activeGroupId = this.groups.has(saved.activeGroupId) ? saved.activeGroupId : firstLeaf(this.tree)?.groupId
    this.renderTree()
    this.setActiveGroup(this.activeGroupId || firstLeaf(this.tree)?.groupId)
    this.scheduleSave()
    return true
  }

  /** 兼容旧版本（页签在上、分屏在下）的会话文件：每个页签拆成一个区域 */
  restoreLegacyTabs(saved) {
    let used = 0
    for (const tab of saved.tabs) {
      const panes = Array.isArray(tab.panes) ? tab.panes : []
      if (panes.length === 0) continue
      const groupId = `g-${Math.random().toString(36).slice(2, 9)}`
      const group = { id: groupId, tabs: [], activeTabId: null, el: null, tabsEl: null }
      this.groups.set(groupId, group)
      this.tree = this.tree ? splitLeaf(this.tree, this.activeGroupId, 'row', groupId) : createLeaf(groupId)
      for (const spec of panes) {
        const paneId = spec.paneId
        const pane = new Pane(this, paneId, {
          shellId: spec.shellId || this.defaultShellId,
          cwd: spec.cwd || null,
          title: spec.title,
        })
        pane.__groupId = groupId
        this.panes.set(paneId, pane)
        group.tabs.push(paneId)
      }
      group.activeTabId = group.tabs.includes(tab.activePaneId) ? tab.activePaneId : group.tabs[0]
      used += 1
    }
    if (used === 0) return false
    this.tree = firstPlaceholder(this.groups)
    this.activeGroupId = firstLeaf(this.tree)?.groupId || null
    this.renderTree()
    this.setActiveGroup(this.activeGroupId)
    this.scheduleSave()
    return true
  }
}

/** 丢掉引用了不存在区域的节点 */
function sanitizeTree(node, groups) {
  if (!node) return null
  if (node.kind === 'leaf') return groups.has(node.groupId) ? node : null
  const a = sanitizeTree(node.a, groups)
  const b = sanitizeTree(node.b, groups)
  if (a && b) return { ...node, a, b }
  return a || b
}

/** 按区域 id 顺序搭一棵简单的左右排列树 */
function firstPlaceholder(groups) {
  let tree = null
  for (const id of groups.keys()) {
    tree = tree ? splitLeaf(tree, tree.kind === 'leaf' ? tree.groupId : firstLeaf(tree).groupId, 'row', id) : createLeaf(id)
  }
  return tree
}
