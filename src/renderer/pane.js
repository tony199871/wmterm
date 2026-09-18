import { createTerminal } from './terminal.js'
import { decodeChunk } from './util.js'

/**
 * 一个终端：xterm 实例 + 与之绑定的 PTY 会话。
 * 它总是住在某个「区域」（group）里，由那个区域的页签栏代表自己。
 */
export class Pane {
  constructor(app, paneId, options = {}) {
    this.app = app
    this.paneId = paneId
    this.title = options.title || app.shellLabel?.(options.shellId) || '终端'
    this.shellId = options.shellId || null
    this.cwd = options.cwd || null
    this.sessionId = null
    this.exited = false
    this.exitedAt = null
    this.needsAttention = false
    this.term = null
    this.fitAddon = null
    this.element = null
    this.termEl = null
    this.resizeObserver = null
    this.fitRaf = 0
    this.disposables = []
    this.started = false
  }

  mount(slot, { autostart = true } = {}) {
    this.element = slot
    this.element.classList.add('pane')

    const body = document.createElement('div')
    body.className = 'pane-body'
    this.element.append(body)

    const { term, fitAddon } = createTerminal({
      onData: (data) => this.#send(data),
      onTitle: (title) => this.#applyTitle(title),
      onResize: (cols, rows) => this.#queueResize(cols, rows),
      onBell: () => this.app.onBell?.(this),
    })
    this.term = term
    this.fitAddon = fitAddon
    term.open(body)
    this.termEl = term.element || body

    const focusHandler = () => this.app.setActivePane(this.paneId)
    this.element.addEventListener('mousedown', focusHandler, true)
    this.element.addEventListener('focusin', focusHandler)
    this.termEl.addEventListener('focus', focusHandler)
    this.disposables.push(() => this.element.removeEventListener('mousedown', focusHandler, true))

    this.resizeObserver = new ResizeObserver(() => this.scheduleFit())
    this.resizeObserver.observe(body)

    // xterm 需要一帧来测量字符尺寸，之后才能算出 cols/rows
    requestAnimationFrame(() => this.scheduleFit())

    if (autostart) this.start()
    return this
  }

  start() {
    if (this.started) return
    this.started = true
    // 用当前已布局出来的尺寸启动，避免先按 80x24 起一个尺寸不对的 ConPTY
    const cols = this.term?.cols || 80
    const rows = this.term?.rows || 24
    window.multi
      .spawn({ shellId: this.shellId, cwd: this.cwd, cols, rows, name: this.title })
      .then((info) => {
        if (!this.term) {
          window.multi.kill(info.id)
          return
        }
        this.sessionId = info.id
        this.shellId = info.shell
        this.cwd = info.cwd
        this.app.registerSession(info.id, this)
        // 布局可能还在变，会话就绪后再对齐一次尺寸
        this.scheduleFit()
        requestAnimationFrame(() => {
          this.scheduleFit()
          if (this.term) window.multi.resize(info.id, this.term.cols, this.term.rows)
        })
        this.focus()
      })
      .catch((error) => {
        this.started = false
        this.#markExited(-1)
        this.term?.write(`\r\n\x1b[31m无法启动终端：${String(error && error.message ? error.message : error)}\x1b[0m\r\n`)
      })
  }

  write(data) {
    // xterm 既能吃字符串，也能吃 Uint8Array（内部按 UTF-8 流式解码）
    this.term?.write(data)
  }

  writeChunk(b64) {
    this.write(decodeChunk(b64))
  }

  scheduleFit() {
    if (this.fitRaf) cancelAnimationFrame(this.fitRaf)
    this.fitRaf = requestAnimationFrame(() => {
      this.fitRaf = 0
      this.fit()
    })
  }

  fit() {
    if (!this.term || !this.fitAddon || !this.element || !this.element.isConnected) return
    const rect = this.element.getBoundingClientRect()
    if (rect.width < 24 || rect.height < 24) return
    try {
      this.fitAddon.fit()
    } catch {
      /* 布局还在变，下一帧再试 */
    }
  }

  focus() {
    if (!this.term) return
    try {
      this.term.focus()
    } catch {
      /* ignore */
    }
  }

  setActive(active) {
    if (!this.element) return
    this.element.classList.toggle('is-active', active)
    if (active) this.scheduleFit()
  }

  onExit(code) {
    this.#markExited(code)
    const label = code === 0 ? '进程已退出' : `进程已退出（代码 ${code}）`
    this.term?.write(`\r\n\x1b[90m── ${label} · 按 Enter 重新启动 ──\x1b[0m\r\n`)
    this.app.onPaneStateChange?.(this)
  }

  #markExited(code) {
    this.exited = true
    this.exitedAt = Date.now()
    this.exitCode = code
    this.element?.classList.add('is-exited')
  }

  restart() {
    if (!this.exited) return
    this.exited = false
    this.started = false
    this.sessionId = null
    this.element?.classList.remove('is-exited')
    this.app.onPaneStateChange?.(this)
    this.term?.reset()
    this.start()
  }

  /** 返回 true 表示按键被本窗格消费 */
  handleKey(event) {
    if (!this.exited) return false
    if (event.key === 'Enter' && !event.ctrlKey && !event.altKey) {
      this.restart()
      return true
    }
    return false
  }

  #send(data) {
    if (this.exited || !this.sessionId) return
    window.multi.write(this.sessionId, data)
  }

  /** 拖拽分隔条时会连续触发 fit，合并成最后一次再通知主进程 */
  #queueResize(cols, rows) {
    this.pendingResize = { cols, rows }
    if (this.resizeTimer) clearTimeout(this.resizeTimer)
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null
      const next = this.pendingResize
      if (!next || !this.sessionId) return
      window.multi.resize(this.sessionId, next.cols, next.rows)
    }, 80)
  }

  #applyTitle(title) {
    const clean = normalizeTitle(String(title || '').trim(), this.shellId, this.app)
    if (!clean) return
    this.title = clean
    this.app.onPaneTitle?.(this)
  }

  serialize() {
    return { title: this.title, shellId: this.shellId, cwd: this.cwd }
  }

  dispose() {
    if (this.fitRaf) cancelAnimationFrame(this.fitRaf)
    if (this.resizeTimer) clearTimeout(this.resizeTimer)
    this.resizeObserver?.disconnect()
    for (const fn of this.disposables) {
      try {
        fn()
      } catch {
        /* ignore */
      }
    }
    this.disposables = []
    if (this.sessionId) window.multi.kill(this.sessionId)
    this.sessionId = null
    try {
      this.term?.dispose()
    } catch {
      /* ignore */
    }
    this.term = null
    this.element?.remove()
    this.element = null
  }
}

/**
 * ConPTY 会把 shell 的标题报成可执行文件全路径
 * （C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe），
 * 直接拿来做页签名字太丑，这里换成友好名字。
 */
function normalizeTitle(title, shellId, app) {
  if (!title) return ''
  const looksLikePath = /^[a-zA-Z]:[\\/]/.test(title) || title.startsWith('\\\\')
  if (!looksLikePath || title.length < 24) return title
  const base = title.replace(/\\/g, '/').split('/').pop() || ''
  const stem = base.replace(/\.exe$/i, '').toLowerCase()
  const known = { powershell: 'Windows PowerShell', pwsh: 'PowerShell 7', cmd: '命令提示符', bash: 'Bash', wsl: 'WSL' }
  if (known[stem]) return known[stem]
  const label = app?.shellLabel?.(shellId)
  const current = app?.shells?.find((s) => s.id === shellId)
  if (current && current.file && title.toLowerCase() === String(current.file).toLowerCase() && label) return label
  return stem || title
}

