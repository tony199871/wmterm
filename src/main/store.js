import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const FILE = 'multi-cmd-state.json'
const SCHEMA_VERSION = 1

/**
 * 极简 JSON 持久化：窗口位置 + 会话布局 + 用户设置。
 * 写入使用「临时文件 + 改名」，避免半截文件把启动搞坏。
 */
export class SessionStore {
  constructor(userDataDir) {
    this.dir = userDataDir
    this.file = path.join(userDataDir, FILE)
    this.state = { version: SCHEMA_VERSION, window: null, session: null, settings: {} }
    this.load()
  }

  load() {
    try {
      if (!existsSync(this.file)) return
      const raw = JSON.parse(readFileSync(this.file, 'utf8'))
      if (raw && raw.version === SCHEMA_VERSION) {
        this.state = {
          version: SCHEMA_VERSION,
          window: raw.window ?? null,
          session: raw.session ?? null,
          settings: raw.settings && typeof raw.settings === 'object' ? raw.settings : {},
        }
      }
    } catch {
      // 状态文件坏了就当没有，不影响启动
    }
  }

  get() {
    return this.state
  }

  /** 用户设置（默认 shell 等），与布局分开存，互不覆盖 */
  getSettings() {
    return this.state.settings || {}
  }

  patchSettings(partial) {
    this.patch({ settings: { ...this.getSettings(), ...(partial || {}) } })
    return this.getSettings()
  }

  patch(partial) {
    this.state = { ...this.state, ...partial }
    this.save()
  }

  save() {
    try {
      mkdirSync(this.dir, { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch {
      // 落盘失败不阻塞用户操作
    }
  }
}
