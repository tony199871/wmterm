/**
 * 把主进程发来的 base64 分块还原成字节流。
 * 用 xterm 的 write(Uint8Array) 而不是 write(string)，
 * 这样跨 chunk 的 UTF-8 字符不会变成乱码。
 */
export function decodeChunk(b64) {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function shortPath(p, max = 34) {
  if (!p) return ''
  let out = p
  const home = window.__HOME__
  if (home && out.toLowerCase().startsWith(String(home).toLowerCase())) {
    out = `~${out.slice(home.length)}`
  }
  if (out.length <= max) return out
  const parts = out.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 2) return out
  return `${parts[0]}…\\${parts[parts.length - 1]}`
}

/** 相对时间：刚刚 / 5 分钟前 / 3 小时前 / 2 天前 */
export function relativeTime(timestamp) {
  const diff = Date.now() - Number(timestamp || 0)
  if (!Number.isFinite(diff) || diff < 0) return ''
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`
  return `${Math.floor(diff / (30 * day))} 个月前`
}

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
