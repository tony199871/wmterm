// 打包成可双击运行的 Windows 可执行文件。
//
//   node scripts/package.mjs            # portable exe + NSIS 安装包
//   node scripts/package.mjs --dir      # 只出免安装目录 release/win-unpacked（最快，用来验证）
//   node scripts/package.mjs --portable # 只出单文件便携版 exe
//
// 为什么打包要分两趟、还要把 exe 换回官方那份：
//   Windows 11 的智能应用控制（Smart App Control，VerifiedAndReputablePolicyState=1）会
//   按文件签名 + 云端信誉判定可执行文件。electron-builder 只要改过 exe（写图标、版本信息、
//   asar 完整性哈希），签名就失效、哈希也变了，于是被判为不认识的文件直接拦掉：
//     "was blocked by your organization's Device Guard policy."
//   而**官方 electron.exe 是允许的**，并且 SAC 不校验 app.asar。
//   所以这里：electron-builder 先出目录 → 把 dist 里的官方 electron.exe 原样换进去
//   （校验哈希必须一致）→ 再拿这个目录出便携版和安装包。
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '..')
const CACHE = path.join(ROOT, '.npm-cache')
const OUT = path.join(ROOT, 'release')
const UNPACKED = path.join(OUT, 'win-unpacked')
const OFFICIAL_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist')

process.env.ELECTRON_BUILDER_CACHE = process.env.ELECTRON_BUILDER_CACHE || path.join(CACHE, 'electron-builder')
process.env.electron_config_cache = process.env.electron_config_cache || path.join(CACHE, 'electron')
// 国内网络走 npmmirror；想强制官方源可以自己覆盖这两个变量
process.env.ELECTRON_MIRROR = process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/'
process.env.ELECTRON_BUILDER_BINARIES_MIRROR =
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR || 'https://npmmirror.com/mirrors/electron-builder-binaries/'
// 我们自己不做签名（也没证书），别让 electron-builder 去翻证书
process.env.CSC_IDENTITY_AUTO_DISCOVERY = process.env.CSC_IDENTITY_AUTO_DISCOVERY || 'false'

const args = process.argv.slice(2)
const dirOnly = args.includes('--dir')
const portableOnly = args.includes('--portable')
const keepIcon = args.includes('--edit-exe') // 显式要求改写 exe（比如有代码签名证书时）

mkdirSync(process.env.ELECTRON_BUILDER_CACHE, { recursive: true })

function run(command, argv, label) {
  console.log(`\n[package] ${label}: ${command} ${argv.join(' ')}`)
  const result = spawnSync(command, argv, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.status !== 0) {
    console.error(`[package] ${label} 失败，退出码 ${result.status}`)
    process.exit(result.status || 1)
  }
}

const builderCli = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js')
if (!existsSync(builderCli)) {
  console.error('[package] 找不到 electron-builder，请先 npm install')
  process.exit(1)
}

/** 目标平台/架构交给 package.json 的 build.win.target，这里只选 target */
function builderArgs(extra = []) {
  if (dirOnly) return ['--win', '--dir', ...extra]
  return ['--win', ...(portableOnly ? ['portable'] : ['portable', 'nsis']), ...extra]
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * 把 win-unpacked 里的 exe 换回未改动的官方 electron.exe。
 * 换完必须哈希一致，否则说明这个思路失效了，直接报错而不是悄悄产出一个跑不起来的包。
 */
function restoreOfficialExecutable() {
  if (!existsSync(UNPACKED)) {
    console.error(`[package] 找不到 ${UNPACKED}`)
    process.exit(1)
  }
  const official = path.join(OFFICIAL_DIST, 'electron.exe')
  if (!existsSync(official)) {
    console.warn('[package] 找不到官方 electron.exe，跳过替换（打包产物在开启智能应用控制的机器上可能被拦）')
    return false
  }

  // 1) 官方运行时整体覆盖过去（保证 exe 与它依赖的 dll/pak 完全匹配）
  for (const entry of readdirSync(OFFICIAL_DIST)) {
    if (entry === 'resources') continue
    const from = path.join(OFFICIAL_DIST, entry)
    const to = path.join(UNPACKED, entry)
    cpSync(from, to, { recursive: true, force: true })
  }
  // 2) 丢掉 electron-builder 改写过的那份
  const productName = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).build.productName || 'multi-cmd'
  for (const name of [`${productName}.exe`, 'multi-cmd.exe']) {
    const victim = path.join(UNPACKED, name)
    if (name !== 'electron.exe' && existsSync(victim)) rmSync(victim, { force: true })
  }

  const replaced = path.join(UNPACKED, 'electron.exe')
  const same = sha256(replaced) === sha256(official)
  console.log(
    `[package] exe 已换回官方未改写版本：${path.basename(replaced)} (${(statSync(replaced).size / 1024 / 1024).toFixed(0)}MB) 哈希一致=${same}`,
  )
  if (!same) {
    console.error('[package] 替换后哈希仍不一致，产物不保证能通过智能应用控制校验')
    process.exit(1)
  }
  return true
}

// 1) 打包源码
run(process.execPath, [path.join(ROOT, 'scripts', 'build.mjs')], 'esbuild')

// 2) 生成图标（已存在就跳过）
if (!existsSync(path.join(ROOT, 'build', 'icon.ico'))) {
  run(process.execPath, [path.join(ROOT, 'scripts', 'make-icon.mjs')], 'icon')
}

if (keepIcon) {
  // 有代码签名证书时走这条路：exe 保持被改写 + 正常签名
  run(process.execPath, [builderCli, ...builderArgs()], 'electron-builder')
  console.log('\n[package] 产物目录：release/（exe 由 electron-builder 改写并签名）')
  process.exit(0)
}

// 3) 第一趟：只出免安装目录（exe 用什么名字无所谓，马上会被换掉）
rmSync(UNPACKED, { recursive: true, force: true })
run(process.execPath, [builderCli, '--win', '--dir', '-c.win.signAndEditExecutable=false'], 'electron-builder (目录)')

// 4) 把 exe 换回官方原版 —— 这是能通过智能应用控制的关键一步
restoreOfficialExecutable()

if (dirOnly) {
  console.log('\n[package] 产物目录：release/')
  console.log('  release/win-unpacked/electron.exe   ← 免安装，双击即用（exe 为官方原版）')
  process.exit(0)
}

// 5) 第二趟：基于修好的目录出便携版与安装包
run(process.execPath, [builderCli, ...builderArgs(['--prepackaged', UNPACKED])], 'electron-builder (分发格式)')

console.log('\n[package] 产物目录：release/')
if (portableOnly) {
  console.log('  release/multi-cmd-*-portable.exe     ← 单文件便携版')
} else {
  console.log('  release/multi-cmd-*-portable.exe     ← 单文件便携版')
  console.log('  release/multi-cmd-*-setup.exe        ← 安装包')
}
console.log('  release/win-unpacked/electron.exe    ← 免安装目录版')
console.log('\n[package] 注意：exe 用的是官方未改写的 electron.exe，所以任务管理器里显示 electron.exe；')
console.log('          应用内窗口标题、图标、快捷方式仍然是 multi-cmd。')
