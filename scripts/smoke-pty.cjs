// 诊断：node-pty 在 Windows 上返回的到底是 Buffer 还是已解码字符串？
// 以及多字节 UTF-8 输出是否会出现跨 chunk 断字。
// 用法：node scripts/smoke-pty.cjs
const fs = require('node:fs')
const pty = require('node-pty')

const candidates = [
  process.env.SmokeShell,
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  'C:\\Windows\\System32\\cmd.exe',
].filter(Boolean)
const file = candidates.find((p) => fs.existsSync(p))
if (!file) {
  console.error('[smoke] 找不到任何 shell')
  process.exit(1)
}

console.log(`[smoke] shell = ${file}`)
const proc = pty.spawn(file, [], {
  name: 'xterm-256color',
  cols: 100,
  rows: 30,
  cwd: process.cwd(),
  env: { ...process.env, TERM: 'xterm-256color' },
  encoding: null,
  useConpty: true,
})

const all = []
let firstType = null
let sawMarker = false
let sawChinese = false
let done = false

const finish = (code, message) => {
  if (done) return
  done = true
  clearTimeout(timer)
  console.log(message)
  try {
    proc.kill()
  } catch {}
  setTimeout(() => process.exit(code), 50)
}

const timer = setTimeout(() => {
  const text = all.join('')
  finish(
    1,
    `[smoke] 超时 chunks=${all.length} bytes=${Buffer.byteLength(text)} chinese=${/中文/.test(text)}`,
  )
}, 15000)

proc.onData((data) => {
  if (firstType === null) {
    firstType = Buffer.isBuffer(data) ? 'Buffer' : typeof data
    console.log(`[smoke] first chunk type=${firstType} constructor=${data && data.constructor && data.constructor.name}`)
  }
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
  all.push(text)

  if (!sawMarker && text.includes('SMOKE_OK')) {
    sawMarker = true
    console.log('[smoke] 收到标记，开始测试多字节输出')
    // 输出大量中文，制造跨 chunk 的边界
    const line = process.platform === 'win32' && file.includes('cmd')
      ? 'for /l %i in (1,1,40) do @echo 中文测试-アカサタナ-😀-OK'
      : '1..40 | % { "中文测试-アカサタナ-😀-OK" }'
    proc.write(`${line}\r`)
  }

  if (sawMarker && /中文测试-アカサタナ-😀-OK/.test(text)) {
    sawChinese = true
  }
  if (sawChinese && /😀-OK/.test(text)) {
    const joined = all.join('')
    const intact = (joined.match(/中文测试-アカサタナ-😀-OK/g) || []).length
    finish(
      0,
      `[smoke] OK 中文/emoji 完整出现 ${intact} 次，chunks=${all.length}，type=${firstType}`,
    )
  }
})

proc.onExit(({ exitCode }) => {
  finish(0, `[smoke] shell 已退出 code=${exitCode}，chunks=${all.length}`)
})

proc.write('echo SMOKE_OK\r')
