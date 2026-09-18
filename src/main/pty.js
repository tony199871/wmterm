import { randomUUID } from 'node:crypto'
import os from 'node:os'
// 注意：node-pty 是 CJS 模块，必须用具名导入。
// 用 default 导入时 esbuild 会生成 __toESM(...).default，而该模块没有 default 导出。
import { spawn as spawnPty } from 'node-pty'

/**
 * 一个 PTY 会话 = 渲染层里的一个终端窗格。
 *
 * 输出采用「合批 + 二进制安全」策略：
 *  - 若 node-pty 返回 Buffer（POSIX），直接拼成 Buffer 转 base64
 *  - Windows 上 node-pty 内部硬编码 setEncoding('utf8')，只能拿到已解码字符串。
 *    这时用「尾随替换字符回带」兜底：chunk 末尾的 U+FFFD 几乎必然是跨 chunk 被切断的
 *    多字节字符，把它扣住拼到下一个 chunk 前面，就不会出现中文变乱码。
 *  - 渲染层统一收到 base64 字节流，用 TextDecoder 流式解码
 */
const FLUSH_INTERVAL_MS = 8
const MAX_BATCH_BYTES = 128 * 1024
const MAX_PENDING_BYTES = 4 * 1024 * 1024
const MIN_COLS = 2
const MIN_ROWS = 1
const REPLACEMENT = '\uFFFD'
const MAX_CARRY = 4

export class PtyManager {
  /**
   * @param {(event: object) => void} emit 向渲染层推送事件
   */
  constructor(emit) {
    this.emit = emit
    /** @type {Map<string, any>} */
    this.sessions = new Map()
  }

  list() {
    return [...this.sessions.entries()].map(([id, s]) => ({
      id,
      pid: s.pty.pid,
      cols: s.cols,
      rows: s.rows,
      title: s.title,
      cwd: s.cwd,
      shell: s.shell,
      name: s.name,
      exited: s.exited,
      exitCode: s.exitCode,
    }))
  }

  spawn({ shell, cwd, cols, rows, name }) {
    const id = randomUUID()
    const initialCols = clampInt(cols, MIN_COLS, 1000, 80)
    const initialRows = clampInt(rows, MIN_ROWS, 1000, 24)

    const proc = spawnPty(shell.file, shell.args, {
      name: 'xterm-256color',
      cols: initialCols,
      rows: initialRows,
      cwd,
      env: buildEnv(shell),
      encoding: null,
      useConpty: process.platform === 'win32' ? true : undefined,
    })

    /** @type {any} */
    const entry = {
      pty: proc,
      buf: [],
      bufBytes: 0,
      timer: null,
      exited: false,
      exitCode: null,
      cols: initialCols,
      rows: initialRows,
      title: '',
      cwd,
      shell: shell.id,
      name: name || shell.label,
      carry: '',
    }
    this.sessions.set(id, entry)

    proc.onData((chunk) => this.#push(id, entry, chunk))
    proc.onExit(({ exitCode }) => {
      entry.exited = true
      entry.exitCode = typeof exitCode === 'number' ? exitCode : null
      this.#flush(id, entry)
      this.emit({ type: 'exit', id, code: entry.exitCode })
    })

    this.emit({ type: 'spawned', id, pid: proc.pid, shell: shell.id, name: entry.name, cwd })

    return { id, pid: proc.pid, cols: initialCols, rows: initialRows, shell: shell.id, name: entry.name, cwd }
  }

  write(id, data) {
    const entry = this.sessions.get(id)
    if (!entry || entry.exited || typeof data !== 'string') return
    try {
      entry.pty.write(data)
    } catch {
      /* 进程已退出，忽略 */
    }
  }

  resize(id, cols, rows) {
    const entry = this.sessions.get(id)
    if (!entry || entry.exited) return
    const c = clampInt(cols, MIN_COLS, 1000, entry.cols)
    const r = clampInt(rows, MIN_ROWS, 1000, entry.rows)
    if (c === entry.cols && r === entry.rows) return
    entry.cols = c
    entry.rows = r
    try {
      entry.pty.resize(c, r)
    } catch {
      /* 忽略竞态 */
    }
  }

  kill(id) {
    const entry = this.sessions.get(id)
    if (!entry) return
    this.sessions.delete(id)
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = null
    entry.buf = []
    entry.bufBytes = 0
    try {
      entry.pty.kill()
    } catch {
      /* 已经死了 */
    }
  }

  killAll() {
    for (const id of [...this.sessions.keys()]) this.kill(id)
  }

  setTitle(id, title) {
    const entry = this.sessions.get(id)
    if (!entry) return
    entry.title = title
  }

  #push(id, entry, chunk) {
    if (Buffer.isBuffer(chunk)) {
      if (chunk.length === 0) return
      entry.buf.push(chunk)
      entry.bufBytes += chunk.length
    } else {
      let text = String(chunk)
      if (entry.carry) {
        text = entry.carry + text
        entry.carry = ''
      }
      if (text.length === 0) return

      // 末尾的替换字符大概率是被切断的多字节字符，扣住等下一个 chunk
      let cut = 0
      while (cut < MAX_CARRY && text.length - cut > 0 && text[text.length - 1 - cut] === REPLACEMENT) cut += 1
      if (cut > 0) {
        entry.carry = text.slice(text.length - cut)
        text = text.slice(0, text.length - cut)
        if (text.length === 0) return
      }
      const buf = Buffer.from(text, 'utf8')
      entry.buf.push(buf)
      entry.bufBytes += buf.length
    }

    if (entry.bufBytes >= MAX_PENDING_BYTES || entry.bufBytes >= MAX_BATCH_BYTES) {
      // 背压保护：终端被刷屏时不无限堆积
      this.#flush(id, entry)
      return
    }
    if (!entry.timer) {
      entry.timer = setTimeout(() => {
        entry.timer = null
        this.#flush(id, entry)
      }, FLUSH_INTERVAL_MS)
    }
  }

  #flush(id, entry) {
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
    if (entry.buf.length === 0) return
    const merged = entry.buf.length === 1 ? entry.buf[0] : Buffer.concat(entry.buf, entry.bufBytes)
    entry.buf = []
    entry.bufBytes = 0
    this.emit({ type: 'data', id, b64: merged.toString('base64') })
  }
}

function clampInt(value, min, max, fallback) {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function buildEnv(shell) {
  const env = { ...process.env }
  // 让终端里的程序认为自己是彩色终端
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.TERM_PROGRAM = 'multi-cmd'
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  if (process.platform === 'win32') {
    env.WT_SESSION = `multi-cmd-${os.hostname()}-${Date.now()}`
  }
  if (shell.env) Object.assign(env, shell.env)
  return env
}
