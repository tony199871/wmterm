import { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell } from 'electron'
import { appendFileSync, existsSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { PtyManager } from './pty.js'
import { ShellCatalog } from './shells.js'
import { SessionStore } from './store.js'

// esbuild 输出 CJS，__dirname 直接可用（就是 dist/）
const distDir = __dirname
const isDev = process.argv.includes('--dev')
const MAX_RECENT_PATHS = 40

/** 写一行诊断日志到 userData/multi-cmd.log，仅在设置 MULTI_CMD_LOG 时启用 */
function log(...args) {
  if (!process.env.MULTI_CMD_LOG) return
  try {
    const line = `${new Date().toISOString()} ${args
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ')}\n`
    appendFileSync(path.join(app.getPath('userData'), 'multi-cmd.log'), line)
  } catch {
    /* 日志失败不影响运行 */
  }
}

/** 这次启动是不是由一个「新建窗口」请求拉起来的：那种窗口不恢复旧会话 */
function isFreshWindow() {
  return process.argv.some((arg) => arg === '--fresh-window' || arg.startsWith('--fresh-window='))
}

/** @type {BrowserWindow | null} */
let win = null
/** @type {BrowserWindow | null} */
let leadWin = null
/** @type {PtyManager | null} */
let ptys = null
/** @type {SessionStore | null} */
let store = null
/** @type {ShellCatalog | null} */
let shells = null

function createWindow({ fresh = false } = {}) {
  const created = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 560,
    minHeight: 360,
    show: false,
    backgroundColor: '#12141a',
    title: 'multi-cmd',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(distDir, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  })

  created.__fresh = fresh
  win = created
  if (!leadWin) leadWin = created

  created.once('ready-to-show', () => {
    log('window ready-to-show')
    created.show()
  })
  created.on('resize', () => persistWindowState(created))
  created.on('move', () => persistWindowState(created))
  created.on('close', () => persistWindowState(created))
  created.on('closed', () => {
    log('window closed')
    if (win === created) win = findLiveWindow()
    if (leadWin === created) leadWin = findLiveWindow()
  })

  created.webContents.on('did-finish-load', () => log('renderer did-finish-load'))
  created.webContents.on('did-fail-load', (_e, code, desc, url) => log('did-fail-load', code, desc, url))
  created.webContents.on('render-process-gone', (_e, details) => log('render-process-gone', details))
  created.webContents.on('console-message', (_e, level, message, line, source) => {
    log('renderer-console', level, `${source}:${line}`, message)
  })
  created.webContents.on('preload-error', (_e, preloadPath, error) => log('preload-error', preloadPath, error.message))

  created.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  created.loadFile(path.join(distDir, 'index.html'))
  if (isDev) created.webContents.openDevTools({ mode: 'detach' })

  return created
}

function findLiveWindow() {
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) || null
}

/** 新窗口：级联偏移，不恢复旧会话 */
function openExtraWindow({ fresh = true } = {}) {
  const base = win && !win.isDestroyed() ? win.getBounds() : null
  const created = createWindow({ fresh })
  if (base) {
    created.setBounds({ x: base.x + 36, y: base.y + 36, width: base.width, height: base.height })
  }
  log('opened extra window', { fresh, id: created.id })
  return { id: created.id }
}

let persistTimer = null
function persistWindowState(target) {
  const w = target && !target.isDestroyed() ? target : win
  if (!w || !store) return
  // 只有主窗口（或被显式指定的窗口）负责记住窗口位置
  if (!target && w !== leadWin) return
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    if (!w || w.isDestroyed()) return
    const bounds = w.isMaximized() ? w.getNormalBounds() : w.getBounds()
    store.patch({ window: { ...bounds, maximized: w.isMaximized() } })
  }, 400)
}

function restoreWindowState() {
  const saved = store?.get().window
  if (!saved) return null
  const visible = !saved.x || !saved.y
    ? true
    : screen.getAllDisplays().some((d) => {
        const { x, y, width, height } = d.workArea
        return saved.x < x + width && saved.x + saved.width > x && saved.y < y + height && saved.y + saved.height > y
      })
  return visible ? saved : null
}

/** 用户设置的默认 shell；没设置或已失效时回落到自动探测的结果 */
function preferredShellId() {
  const wanted = store.getSettings().defaultShellId
  if (wanted && shells.list().some((s) => s.id === wanted)) return wanted
  return shells.defaultId()
}

/** 把历史记录里已经被删掉/改名的目录标出来，顺手按「常用 + 最近」排好序 */
function normalizePaths(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const entry of list) {
    if (!entry) continue
    const p = typeof entry === 'string' ? entry : entry.path
    if (typeof p !== 'string' || p.trim() === '') continue
    out.push({
      path: p,
      count: Number.isFinite(entry.count) ? entry.count : 1,
      at: Number.isFinite(entry.at) ? entry.at : 0,
    })
  }
  return out
}

function rankPaths(list) {
  return normalizePaths(list)
    .map((entry) => ({ ...entry, exists: existsSync(entry.path) }))
    .sort((a, b) => b.count - a.count || b.at - a.at)
}

function registerIpc() {
  ipcMain.handle('app:info', (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    return {
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      platform: process.platform,
      home: app.getPath('home'),
      cwd: safeCwd(),
      shells: shells.list(),
      defaultShellId: preferredShellId(),
      settings: store.getSettings(),
      // 由「新建窗口」拉起来的窗口不恢复旧会话，否则会把旧布局的每个终端都重启一遍
      fresh: owner ? owner.__fresh === true : isFreshWindow(),
      // 只给渲染层会话布局本身，不要把窗口状态也塞进去
      session: store.get().session,
    }
  })

  ipcMain.handle('settings:get', () => store.getSettings())

  ipcMain.handle('settings:set', (_e, partial) => {
    const next = store.patchSettings(partial)
    log('settings updated', next)
    return next
  })

  /** 「在指定路径打开终端」的历史记录：按使用次数 + 最近使用排序，最多留 40 条 */
  ipcMain.handle('paths:recent', () => rankPaths(store.getSettings().recentPaths))

  ipcMain.handle('paths:touch', (_e, target) => {
    const dir = typeof target === 'string' ? target.trim() : ''
    if (!dir) return rankPaths(store.getSettings().recentPaths)
    const now = Date.now()
    const list = normalizePaths(store.getSettings().recentPaths)
    const hit = list.find((entry) => entry.path.toLowerCase() === dir.toLowerCase())
    if (hit) {
      hit.count += 1
      hit.at = now
      hit.path = dir
    } else {
      list.push({ path: dir, count: 1, at: now })
    }
    list.sort((a, b) => b.at - a.at)
    const next = list.slice(0, MAX_RECENT_PATHS)
    store.patchSettings({ recentPaths: next })
    return rankPaths(next)
  })

  ipcMain.handle('paths:forget', (_e, target) => {
    const dir = typeof target === 'string' ? target.trim().toLowerCase() : ''
    const list = normalizePaths(store.getSettings().recentPaths).filter((e) => e.path.toLowerCase() !== dir)
    store.patchSettings({ recentPaths: list })
    return rankPaths(list)
  })

  ipcMain.handle('paths:pick', async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(owner || undefined, {
      title: '选择终端要打开的目录',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '在此打开终端',
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('paths:check', (_e, target) => {
    const dir = typeof target === 'string' ? target.trim() : ''
    if (!dir) return { ok: false, reason: '路径为空' }
    if (!existsSync(dir)) return { ok: false, reason: '路径不存在' }
    try {
      if (!statSync(dir).isDirectory()) return { ok: false, reason: '这不是一个目录' }
    } catch {
      return { ok: false, reason: '无法读取这个路径' }
    }
    return { ok: true, path: dir }
  })

  ipcMain.handle('window:open', () => {
    try {
      return openExtraWindow({ fresh: true })
    } catch (error) {
      log('open window failed', String(error && error.stack ? error.stack : error))
      throw error
    }
  })

  ipcMain.handle('shells:list', () => shells.list())

  ipcMain.handle('pty:spawn', (_e, opts) => {
    const spec = shells.resolve(opts?.shellId)
    const cwd = opts?.cwd && existsSync(opts.cwd) ? opts.cwd : safeCwd()
    log('spawn', { shell: spec.id, file: spec.file, cwd, cols: opts?.cols, rows: opts?.rows })
    try {
      const info = ptys.spawn({ ...opts, shell: spec, cwd })
      log('spawned', info)
      return info
    } catch (error) {
      log('spawn failed', String(error && error.stack ? error.stack : error))
      throw error
    }
  })

  ipcMain.handle('pty:write', (_e, { id, data }) => {
    ptys.write(id, data)
    return true
  })

  ipcMain.handle('pty:resize', (_e, { id, cols, rows }) => {
    ptys.resize(id, cols, rows)
    return true
  })

  ipcMain.handle('pty:kill', (_e, { id }) => {
    ptys.kill(id)
    return true
  })

  ipcMain.handle('pty:list', () => ptys.list())

  ipcMain.handle('session:save', (event, state) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (owner && owner.__fresh) {
      // 「新建窗口」开出来的窗口不接管持久化布局，否则会把主窗口的标签页覆盖掉
      return false
    }
    // 允许只更新部分字段（比如只记 splitMode）而不丢掉布局
    store.patch({ session: { ...(store.get().session || {}), ...(state || {}) } })
    return true
  })

  ipcMain.handle('window:close', (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (owner && !owner.isDestroyed()) owner.close()
    return true
  })

  ipcMain.handle('session:clear', () => {
    store.patch({ session: null })
    return true
  })
}

function safeCwd() {
  const home = app.getPath('home')
  return existsSync(home) ? home : process.cwd()
}

/** 自检：把窗口截图和 PTY 会话状态写到 userData，供人工或脚本核对 */
async function runSelfTest() {
  try {
    const sessions = ptys?.list() || []
    log('selftest sessions', sessions)
    if (win && !win.isDestroyed()) {
      const image = await win.webContents.capturePage()
      const file = path.join(app.getPath('userData'), 'selftest.png')
      writeFileSync(file, image.toPNG())
      log('selftest screenshot', file, `${image.getSize().width}x${image.getSize().height}`)
      const title = await win.webContents.executeJavaScript('document.title')
      const structure = await win.webContents.executeJavaScript(`(() => {
        const a = window.__app
        if (!a) return { error: 'no app' }
        const groups = [...a.groups.values()]
        return {
          groups: groups.length,
          tabsPerGroup: groups.map((g) => g.tabs.length),
          panes: a.panes.size,
          started: [...a.panes.values()].filter((p) => p.sessionId).length,
          tabbarsInDom: document.querySelectorAll('.group-tabbar').length,
          activeGroupId: a.activeGroupId,
        }
      })()`)
      const rendered = await win.webContents.executeJavaScript(`(() => {
        const pane = window.__app && window.__app.activePane
        if (!pane || !pane.term) return { error: 'no pane' }
        const buffer = pane.term.buffer.active
        let text = ''
        for (let i = 0; i < Math.min(buffer.length, 200); i += 1) {
          const line = buffer.getLine(i)
          if (line) text += line.translateToString(true) + '\\n'
        }
        return {
          cols: pane.term.cols,
          rows: pane.term.rows,
          bufferLines: buffer.length,
          hasPrompt: text.indexOf('PS ') >= 0 || text.indexOf('>') >= 0,
          textTail: text.trim().split(String.fromCharCode(10)).slice(-3).join(' | ').slice(0, 200),
          xtermRowsInDom: document.querySelectorAll('.pane .xterm-rows > div').length,
        }
      })()`)
      log('selftest renderer', { title, structure, rendered })
    } else {
      log('selftest: no window')
    }
  } catch (error) {
    log('selftest failed', String(error && error.stack ? error.stack : error))
  }
}

/** 自动化 UI 验收：分屏、开标签页、关闭窗格、持久化，逐步记录结果 */
async function runUiTest() {
  const scriptWin = win
  const tag = () => (scriptWin && !scriptWin.isDestroyed() ? `w${scriptWin.id}` : 'gone')
  const step = async (name, script, wait = 1200) => {
    try {
      if (!scriptWin || scriptWin.isDestroyed()) {
        log('uitest', `${tag()} ${name}`, 'window gone')
        return null
      }
      const probe = await scriptWin.webContents.executeJavaScript(
        `({ hasApp: typeof window.__app !== 'undefined', url: location.href, rootLen: document.getElementById('root') ? document.getElementById('root').innerHTML.length : -1, slots: document.querySelectorAll('.group-slot').length })`,
      )
      const result = await scriptWin.webContents.executeJavaScript(`(async () => { ${script} })()`)
      log('uitest', `${tag()} ${name}`, { probe, result })
      await new Promise((resolve) => setTimeout(resolve, wait))
      return result
    } catch (error) {
      log('uitest FAILED', `${tag()} ${name}`, String(error && error.message ? error.message : error))
      return null
    }
  }

  try {
    if (process.env.MULTI_CMD_UITEST_EVAL) {
      const result = await win.webContents.executeJavaScript(`(async () => {
        try {
          ${process.env.MULTI_CMD_UITEST_EVAL}
        } catch (error) {
          return { __error: String(error && error.message ? error.message : error) }
        }
      })()`)
      log('uitest eval', JSON.stringify(result))
      return
    }
    const snapshot = `const a = window.__app; const gs = [...a.groups.values()]; return { splitMode: a.splitMode, groups: gs.length, tabsPerGroup: gs.map(g => g.tabs.length), panes: a.panes.size, tabbarsInDom: document.querySelectorAll('.group-tabbar').length, tabbarsPerGroup: [...document.querySelectorAll('.group-slot')].map(s => s.querySelectorAll('.group-tabbar').length), firstTabLeft: (() => { const t = document.querySelector('.group-tabs .tab'); const box = document.querySelector('.group-tabs'); return t && box ? Math.round(t.getBoundingClientRect().left - box.getBoundingClientRect().left) : null })(), dividerTops: [...document.querySelectorAll('.divider-row')].map(d => Math.round(d.getBoundingClientRect().top - document.querySelector('.layout').getBoundingClientRect().top)) }`
    await step('snapshot-before', snapshot, 500)
    await step(
      'default-shell-switch',
      `const a = window.__app; const available = a.shells.map(s => s.id); const original = a.defaultShellId; const other = available.find(id => id !== original); if (!other) return { skipped: true, available }; await a.setDefaultShell(other); const chip = document.querySelector('.shell-picker'); const pane = a.addTab(a.activeGroup.id, { shellId: a.defaultShellId }); await new Promise(r => setTimeout(r, 1500)); const saved = await window.multi.getSettings(); const result = { available, original, switchedTo: other, nowDefault: a.defaultShellId, chipText: chip ? chip.textContent : null, newPaneShell: pane ? pane.shellId : null, persisted: saved.defaultShellId, ok: a.defaultShellId === other && pane && pane.shellId === other && saved.defaultShellId === other }; await a.setDefaultShell(original); return result`,
      1500,
    )
    await step(
      'open-at-path-and-history',
      `const a = window.__app; const target = a.info.cwd; const before = { tabs: a.activeGroup.tabs.length, history: a.pathHistory().length }; const pane = await a.openAtPath(target); await new Promise(r => setTimeout(r, 1600)); const history = await window.multi.recentPaths(); const bad = await a.openAtPath('D:\\\\definitely\\\\not\\\\here'); const check = await window.multi.checkPath(target); return { before, opened: { shell: pane && pane.shellId, cwd: pane && pane.cwd }, tabsAfter: a.activeGroup.tabs.length, history: history.map(e => ({ path: e.path, count: e.count, exists: e.exists })), badRejected: bad === null, checkOk: check.ok, ok: !!pane && pane.cwd === target && bad === null && history.some(e => e.path === target) }`,
      1500,
    )
    await step(
      'path-dialog-renders',
      `const a = window.__app; a.openPathDialog(); await new Promise(r => setTimeout(r, 900)); const box = document.querySelector('.dialog'); const items = [...document.querySelectorAll('.dialog-item')]; const info = { rendered: !!box, title: box ? box.querySelector('.dialog-title').textContent : null, input: box ? box.querySelector('.dialog-input').value : null, historyItems: items.length, firstMeta: items[0] ? items[0].querySelector('.dialog-item-meta').textContent : null }; const input = box ? box.querySelector('.dialog-input') : null; if (input) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await new Promise(r => setTimeout(r, 300)); info.closedByEsc = !document.querySelector('.dialog'); return info`,
      800,
    )
    await step(
      'ctrl-shift-d-adds-tab-in-region',
      `const a = window.__app; const g = a.activeGroup; const before = { groups: a.groups.size, tabs: g.tabs.length }; a.duplicatePane(a.activePane.paneId, 'row'); const after = { groups: a.groups.size, tabs: a.activeGroup.tabs.length, activeIsNew: a.activePane.paneId !== null }; return { before, after, sameRegion: before.groups === after.groups, addedTab: after.tabs === before.tabs + 1 }`,
      2500,
    )
    await step(
      'ctrl-shift-d-again',
      `const a = window.__app; const g = a.activeGroup; a.duplicatePane(a.activePane.paneId, 'row'); return { groups: a.groups.size, tabsInActiveRegion: a.activeGroup.tabs.length, allTabsPerGroup: [...a.groups.values()].map(x => x.tabs.length) }`,
      2500,
    )
    await step(
      'ctrl-shift-e-splits-into-new-region',
      `const a = window.__app; const before = { groups: a.groups.size }; a.splitIntoNewGroup(a.activePane.paneId, 'row'); const gs = [...a.groups.values()]; return { before, after: { groups: a.groups.size, tabsPerGroup: gs.map(g => g.tabs.length), tabbarsInDom: document.querySelectorAll('.group-tabbar').length, dividers: document.querySelectorAll('.divider').length } }`,
      2500,
    )
    await step('after-split-structure', snapshot, 800)
    await step(
      'regions-have-own-tabbars',
      `const a = window.__app; const slots = [...document.querySelectorAll('.group-slot')]; return { slots: slots.length, tabbarPerSlot: slots.map(s => s.querySelectorAll('.group-tabbar').length), firstTabOffsets: slots.map(s => { const t = s.querySelector('.group-tabs .tab'); const box = s.querySelector('.group-tabs'); return t && box ? Math.round(t.getBoundingClientRect().left - box.getBoundingClientRect().left) : null }) }`,
      500,
    )
    await step(
      'divider-spans-full-height',
      `const a = window.__app; const layout = document.querySelector('.layout').getBoundingClientRect(); const d = document.querySelector('.divider-row'); const tabbar = document.querySelector('.group-tabbar').getBoundingClientRect(); if (!d) return { error: 'no vertical divider' }; const r = d.getBoundingClientRect(); return { dividerTop: Math.round(r.top - layout.top), dividerBottom: Math.round(layout.bottom - r.bottom), tabbarTop: Math.round(tabbar.top - layout.top), cutsThroughTabbar: Math.round(r.top - layout.top) <= Math.round(tabbar.top - layout.top) }`,
      500,
    )
    await step(
      'focus-moves-between-regions',
      `const a = window.__app; const ids = [...a.groups.keys()]; const before = a.activeGroupId; a.moveFocus('left'); const afterLeft = a.activeGroupId; a.moveFocus('right'); const back = a.activeGroupId; return { regions: ids.length, ids, before, afterLeft, back, movedLeft: before !== afterLeft, movedBack: back === before }`,
      800,
    )
    await step(
      'mode-window-opens-window',
      `const a = window.__app; a.setSplitMode('window'); const r = await window.multi.openWindow(); a.setSplitMode('tab'); return { opened: r, mode: a.splitMode }`,
      2500,
    )
    await step(
      'close-region-merges-tabs',
      `const a = window.__app; if (a.groups.size < 2) return { skipped: true }; const before = { groups: a.groups.size, panes: a.panes.size }; a.closeGroup(a.activeGroupId); const gs = [...a.groups.values()]; return { before, after: { groups: a.groups.size, panes: a.panes.size, tabsPerGroup: gs.map(g => g.tabs.length) }, panesSurvived: a.panes.size === before.panes }`,
      1500,
    )
    await step(
      'session-serialize',
      `const a = window.__app; const s = a.serialize(); return { splitMode: s.splitMode, groups: s.groups.length, tabsPerGroup: s.groups.map(g => g.tabs.length), panes: s.panes.length }`,
    )
    await step(
      'dom-summary',
      `const a = window.__app; const root = document.getElementById('root'); return { groupSlots: document.querySelectorAll('.group-slot').length, tabbars: document.querySelectorAll('.group-tabbar').length, tabs: document.querySelectorAll('.tab').length, dividers: document.querySelectorAll('.divider').length, panes: document.querySelectorAll('.pane').length, layoutChildren: document.querySelector('.layout') ? document.querySelector('.layout').children.length : -1, layoutHtmlLen: document.querySelector('.layout') ? document.querySelector('.layout').innerHTML.length : -1, rootHtmlLen: root ? root.innerHTML.length : -1, treeKind: a.tree ? a.tree.kind : 'null', groupsInState: a.groups.size }`,
    )
    const image = await scriptWin.webContents.capturePage()
    const file = path.join(app.getPath('userData'), 'uitest.png')
    writeFileSync(file, image.toPNG())
    log('uitest screenshot', file)
    log('uitest windows', BrowserWindow.getAllWindows().map((w) => ({ id: w.id, fresh: w.__fresh === true })))
    log('uitest final sessions', (ptys?.list() || []).map((s) => ({ shell: s.shell, cols: s.cols, rows: s.rows, exited: s.exited })))
    log('uitest state file', store.get().session ? 'written' : 'missing')
  } catch (error) {
    log('uitest aborted', String(error && error.stack ? error.stack : error))
  }
}


function installMenu() {
  // 无菜单栏，但保留基本快捷键（复制/粘贴/重载/退出）
  const template = [
    {
      label: '应用',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

const gotLock = app.requestSingleInstanceLock()
log('singleInstanceLock', gotLock, process.argv.slice(1))
if (!gotLock) {
  log('another instance holds the lock, quitting')
  app.quit()
} else {
  app.on('second-instance', () => {
    const target = leadWin && !leadWin.isDestroyed() ? leadWin : findLiveWindow()
    if (target) {
      if (target.isMinimized()) target.restore()
      target.focus()
    }
  })

  app.whenReady().then(() => {
    // 打包后进程名是官方 electron.exe（为了通过智能应用控制），
    // 靠 AppUserModelID 让任务栏分组和通知仍然归到 multi-cmd 名下
    try {
      app.setAppUserModelId('com.multicmd.app')
    } catch {
      /* 非打包环境可能不支持，忽略 */
    }
    log('app ready', { electron: process.versions.electron, node: process.versions.node })
    store = new SessionStore(app.getPath('userData'))
    shells = new ShellCatalog()
    log('shells', shells.list().map((s) => s.id))
    ptys = new PtyManager((event) => {
      if (win && !win.isDestroyed()) win.webContents.send('pty:event', event)
    })

    const saved = restoreWindowState()
    const created = createWindow({ fresh: isFreshWindow() })
    if (saved && !isFreshWindow()) {
      if (saved.width && saved.height) created.setSize(saved.width, saved.height)
      if (typeof saved.x === 'number' && typeof saved.y === 'number') created.setPosition(saved.x, saved.y)
      if (saved.maximized) created.maximize()
    }

    installMenu()
    registerIpc()
    log('ipc registered')

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })

    // 自检模式：截图 + 打印 PTY 状态后自动退出，用于无人值守验证
    if (process.env.MULTI_CMD_SELFTEST) {
      const delay = Number(process.env.MULTI_CMD_SELFTEST) || 8000
      setTimeout(() => runSelfTest().finally(() => app.quit()), delay)
    } else if (process.env.MULTI_CMD_UITEST) {
      setTimeout(() => runUiTest().finally(() => app.quit()), Number(process.env.MULTI_CMD_UITEST) || 4000)
    }
  })

  app.on('window-all-closed', () => {
    ptys?.killAll()
    app.quit()
  })

  app.on('before-quit', () => {
    ptys?.killAll()
  })
}
