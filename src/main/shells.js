import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * 发现本机可用的 shell，并把「用户选的 id」解析成 node-pty 需要的
 * { file, args, label, env } 描述。
 */
export class ShellCatalog {
  constructor() {
    this.entries = detectShells()
    if (this.entries.length === 0) {
      this.entries = [{ id: 'cmd', label: '命令提示符', file: 'cmd.exe', args: [], source: 'fallback' }]
    }
    const preferred = process.env.MULTI_CMD_SHELL
    const found = preferred ? this.entries.find((e) => e.id === preferred) : null
    this.default = found || this.entries.find((e) => e.default) || this.entries[0]
  }

  list() {
    return this.entries.map(({ id, label, file, source, default: isDefault }) => ({
      id,
      label,
      file,
      source,
      default: isDefault === true || id === this.default.id,
    }))
  }

  defaultId() {
    return this.default.id
  }

  resolve(id) {
    const hit = id ? this.entries.find((e) => e.id === id) : null
    const chosen = hit || this.default
    return {
      id: chosen.id,
      label: chosen.label,
      file: chosen.file,
      args: chosen.args,
      env: chosen.env,
    }
  }
}

function detectShells() {
  if (process.platform !== 'win32') return detectPosixShells()

  /** @type {Array<{id: string, label: string, file: string, args: string[], env?: Record<string,string>, source: string, default?: boolean}>} */
  const list = []
  const seen = new Set()

  const push = (entry) => {
    if (!entry.file || seen.has(entry.id)) return
    if (!existsSync(entry.file)) return
    seen.add(entry.id)
    list.push(entry)
  }

  // 1) PowerShell 7+ (pwsh)
  for (const candidate of pwshCandidates()) {
    if (existsSync(candidate)) {
      push({
        id: 'pwsh',
        label: 'PowerShell 7',
        file: candidate,
        args: ['-NoLogo'],
        source: 'pwsh',
        default: true,
      })
      break
    }
  }

  // 2) Windows PowerShell 5.1
  push({
    id: 'powershell',
    label: 'Windows PowerShell',
    file: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoLogo'],
    source: 'system',
    default: list.length === 0,
  })

  // 3) cmd
  push({
    id: 'cmd',
    label: '命令提示符',
    file: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'),
    args: [],
    source: 'system',
    default: list.length === 0,
  })

  // 4) Git Bash
  for (const candidate of [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ]) {
    if (candidate && existsSync(candidate)) {
      push({
        id: 'gitbash',
        label: 'Git Bash',
        file: candidate,
        args: ['--login', '-i'],
        env: { MSYSTEM: 'MINGW64', CHERE_INVOKING: '1' },
        source: 'git',
      })
      break
    }
  }

  // 5) WSL 发行版
  const wsl = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wsl.exe')
  if (existsSync(wsl)) {
    for (const distro of listWslDistros(wsl)) {
      push({
        id: `wsl:${distro}`,
        label: `WSL · ${distro}`,
        file: wsl,
        args: ['-d', distro, '--cd', '~'],
        source: 'wsl',
      })
    }
  }

  // 6) 老式 MSYS2 / Cygwin 之类的手动配置
  for (const candidate of ['C:\\msys64\\usr\\bin\\bash.exe']) {
    if (existsSync(candidate)) {
      push({ id: 'msys2', label: 'MSYS2 Bash', file: candidate, args: ['--login', '-i'], source: 'msys2' })
    }
  }

  return list
}

function detectPosixShells() {
  const list = []
  const shell = process.env.SHELL || '/bin/bash'
  if (existsSync(shell)) {
    list.push({ id: 'default', label: path.basename(shell), file: shell, args: ['-l'], source: 'env', default: true })
  }
  for (const candidate of ['/bin/zsh', '/bin/bash', '/bin/fish', '/bin/sh']) {
    if (existsSync(candidate)) {
      list.push({ id: path.basename(candidate), label: path.basename(candidate), file: candidate, args: ['-l'], source: 'system' })
    }
  }
  return list
}

function pwshCandidates() {
  const out = [
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe',
  ]
  const local = process.env.LOCALAPPDATA
  if (local) out.push(path.join(local, 'Microsoft', 'WindowsApps', 'pwsh.exe'))
  return out
}

function listWslDistros(wslExe) {
  try {
    const raw = execFileSync(wslExe, ['-l', '-q'], { encoding: 'utf16le', timeout: 4000, windowsHide: true })
    return raw
      .split(/\r?\n/)
      .map((line) => line.replace(/\u0000/g, '').trim())
      .filter((line) => line.length > 0)
      .slice(0, 6)
  } catch {
    // WSL 未安装时会打印一条中文提示到 stderr，这里直接忽略
    return []
  }
}
