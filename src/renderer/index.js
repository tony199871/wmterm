import { App } from './app.js'

const app = new App(document.getElementById('root'))
window.__app = app

// 把渲染层的未捕获异常也送回主进程日志，方便无人值守排查
window.addEventListener('error', (event) => {
  console.error('[uncaught]', event.message, `${event.filename}:${event.lineno}:${event.colno}`, event.error?.stack || '')
})
window.addEventListener('unhandledrejection', (event) => {
  console.error('[unhandled-rejection]', String(event.reason?.stack || event.reason))
})

app.boot().catch((error) => {
  console.error('[boot-failed]', String(error && error.stack ? error.stack : error))
  document.getElementById('root').innerHTML = `<div class="fatal">启动失败：${String(
    error && error.stack ? error.stack : error,
  )}</div>`
})
