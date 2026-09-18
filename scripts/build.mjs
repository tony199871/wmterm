// 构建脚本：用 esbuild 打包主进程与渲染层，并把渲染层需要的静态资源复制到 dist/
// 原生模块 node-pty 必须保持 external，不能被打包。
import { build } from 'esbuild'
import { cp, mkdir, rm, writeFile, access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'

const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..')
const dist = path.join(root, 'dist')
const watch = process.argv.includes('--watch')

async function copyStatic() {
  await mkdir(dist, { recursive: true })

  // xterm 的样式表必须从 HTML 里 <link> 进来（esbuild 会把它拆成独立文件，
  // 在 file:// 协议下不好引用），所以直接从 node_modules 复制一份。
  const xtermCss = require.resolve('@xterm/xterm/css/xterm.css')
  await cp(xtermCss, path.join(dist, 'xterm.css'))

  await writeFile(
    path.join(dist, 'index.html'),
    `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:" />
<title>multi-cmd</title>
<link rel="stylesheet" href="./xterm.css" />
<link rel="stylesheet" href="./app.css" />
</head>
<body>
<div id="root"></div>
<script src="./renderer.js"></script>
</body>
</html>
`,
    'utf8',
  )

  await cp(path.join(root, 'src', 'renderer', 'app.css'), path.join(dist, 'app.css'))
}

/** 构建完自检：index.html 必须存在，否则 Electron 只会加载出一个错误页 */
async function verifyDist() {
  const required = ['index.html', 'main.js', 'preload.js', 'renderer.js', 'app.css', 'xterm.css']
  const missing = []
  for (const name of required) {
    try {
      await access(path.join(dist, name))
    } catch {
      missing.push(name)
    }
  }
  if (missing.length > 0) {
    throw new Error(`dist/ 缺少产物：${missing.join(', ')}（构建没有完整跑完）`)
  }
}

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
}

const mainCtx = {
  ...shared,
  entryPoints: [path.join(root, 'src', 'main', 'index.js')],
  outfile: path.join(dist, 'main.js'),
  format: 'cjs',
  // node-pty 是原生模块，必须运行时 require；electron 由运行时提供
  external: ['electron', 'node-pty'],
}

const preloadCtx = {
  ...shared,
  entryPoints: [path.join(root, 'src', 'preload', 'index.js')],
  outfile: path.join(dist, 'preload.js'),
  format: 'cjs',
  external: ['electron'],
}

const rendererCtx = {
  ...shared,
  entryPoints: [path.join(root, 'src', 'renderer', 'index.js')],
  outfile: path.join(dist, 'renderer.js'),
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
}

const contexts = [mainCtx, preloadCtx, rendererCtx]

if (watch) {
  const { context } = await import('esbuild')
  await rm(dist, { recursive: true, force: true })
  await copyStatic()
  for (const cfg of contexts) {
    const ctx = await context(cfg)
    await ctx.watch()
  }
  console.log('[build] watching...')
} else {
  // 顺序很重要：先清干净、铺静态资源（顺便确保 dist/ 存在），再让 esbuild 产出
  await rm(dist, { recursive: true, force: true })
  await mkdir(dist, { recursive: true })
  await copyStatic()
  await Promise.all(contexts.map((cfg) => build(cfg)))
  await verifyDist()
  console.log('[build] done -> dist/')
}
