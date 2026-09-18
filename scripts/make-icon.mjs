// 生成应用图标：先画一张 1024x1024 的终端图标，再降采样成 16/24/32/48/64/128/256
// 最后打包成多尺寸 .ico（每帧用 PNG 压缩，Windows Vista+ 支持）。
// 只依赖 Node 内置 zlib，不需要任何图像库。
// 用法：node scripts/make-icon.mjs
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT_DIR = path.join(ROOT, 'build')
const SIZES = [256, 128, 64, 48, 32, 24, 16]
const MASTER = 1024

// ---------------------------------------------------------------- 画图

const BG_TOP = [0x1e, 0x28, 0x38]
const BG_BOTTOM = [0x0d, 0x11, 0x17]
const CHEVRON = [0x4f, 0xc3, 0xf7]
const CURSOR = [0x9a, 0xe6, 0xff]

function render(size) {
  const px = new Float32Array(size * size * 4) // RGBA, 0..255
  const radius = size * 0.22
  const stroke = size * 0.075

  const inside = (x, y) => {
    // 圆角矩形
    const r = radius
    const cx = Math.min(Math.max(x, r), size - r)
    const cy = Math.min(Math.max(y, r), size - r)
    const dx = x - cx
    const dy = y - cy
    return dx * dx + dy * dy <= r * r + 0.0001 || (x >= r && x <= size - r) || (y >= r && y <= size - r)
  }

  // 圆角遮罩 + 竖向渐变背景
  for (let y = 0; y < size; y += 1) {
    const t = y / (size - 1)
    const base = [
      BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t,
      BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t,
      BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t,
    ]
    for (let x = 0; x < size; x += 1) {
      if (!inside(x, y)) continue
      const i = (y * size + x) * 4
      px[i] = base[0]
      px[i + 1] = base[1]
      px[i + 2] = base[2]
      px[i + 3] = 255
    }
  }

  // 画一条粗线（带圆形端点），coverage 用于抗锯齿
  const drawLine = (x1, y1, x2, y2, width, color, alpha = 1) => {
    const half = width / 2
    const minX = Math.max(0, Math.floor(Math.min(x1, x2) - half - 1))
    const maxX = Math.min(size - 1, Math.ceil(Math.max(x1, x2) + half + 1))
    const minY = Math.max(0, Math.floor(Math.min(y1, y2) - half - 1))
    const maxY = Math.min(size - 1, Math.ceil(Math.max(y1, y2) + half + 1))
    const vx = x2 - x1
    const vy = y2 - y1
    const len2 = vx * vx + vy * vy || 1

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const pxc = x + 0.5
        const pyc = y + 0.5
        let t = ((pxc - x1) * vx + (pyc - y1) * vy) / len2
        t = Math.min(1, Math.max(0, t))
        const nx = x1 + vx * t
        const ny = y1 + vy * t
        const dist = Math.hypot(pxc - nx, pyc - ny)
        // 距离场 -> 覆盖率（1px 羽化）
        const cov = Math.min(1, Math.max(0, half - dist + 0.5))
        if (cov <= 0) continue
        const i = (y * size + x) * 4
        if (px[i + 3] === 0) continue
        const a = cov * alpha
        px[i] = px[i] * (1 - a) + color[0] * a
        px[i + 1] = px[i + 1] * (1 - a) + color[1] * a
        px[i + 2] = px[i + 2] * (1 - a) + color[2] * a
      }
    }
  }

  // ">" 折线
  const chevX = size * 0.3
  const chevMidX = size * 0.5
  const topY = size * 0.33
  const midY = size * 0.5
  const bottomY = size * 0.67
  drawLine(chevX, topY, chevMidX, midY, stroke, CHEVRON)
  drawLine(chevMidX, midY, chevX, bottomY, stroke, CHEVRON)

  // "_" 光标
  const barY = size * 0.72
  drawLine(size * 0.55, barY, size * 0.78, barY, stroke, CURSOR)

  return px
}

/** 盒式降采样 */
function downsample(src, srcSize, dstSize) {
  const dst = new Float32Array(dstSize * dstSize * 4)
  const scale = srcSize / dstSize
  for (let y = 0; y < dstSize; y += 1) {
    const y0 = Math.floor(y * scale)
    const y1 = Math.min(srcSize, Math.ceil((y + 1) * scale))
    for (let x = 0; x < dstSize; x += 1) {
      const x0 = Math.floor(x * scale)
      const x1 = Math.min(srcSize, Math.ceil((x + 1) * scale))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const i = (sy * srcSize + sx) * 4
          // 预乘 alpha 再平均，避免边缘出现黑边
          const al = src[i + 3] / 255
          r += src[i] * al
          g += src[i + 1] * al
          b += src[i + 2] * al
          a += src[i + 3]
          n += 1
        }
      }
      const di = (y * dstSize + x) * 4
      const avgA = a / n
      const norm = avgA > 0 ? 255 / avgA / (n / n) : 0
      dst[di] = avgA > 0 ? Math.min(255, (r / n) * (255 / avgA)) : 0
      dst[di + 1] = avgA > 0 ? Math.min(255, (g / n) * (255 / avgA)) : 0
      dst[di + 2] = avgA > 0 ? Math.min(255, (b / n) * (255 / avgA)) : 0
      dst[di + 3] = avgA
      void norm
    }
  }
  return dst
}

// ---------------------------------------------------------------- PNG 编码

function crc32(buf) {
  let c
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256)
    for (let n = 0; n < 256; n += 1) {
      c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[n] = c
    }
    return t
  })())
  let crc = -1
  for (let i = 0; i < buf.length; i += 1) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

function encodePng(px, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1)
    raw[rowStart] = 0 // filter: none
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4
      const o = rowStart + 1 + x * 4
      raw[o] = Math.round(Math.min(255, Math.max(0, px[i])))
      raw[o + 1] = Math.round(Math.min(255, Math.max(0, px[i + 1])))
      raw[o + 2] = Math.round(Math.min(255, Math.max(0, px[i + 2])))
      raw[o + 3] = Math.round(Math.min(255, Math.max(0, px[i + 3])))
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 把多张 PNG 打包成 .ico（PNG 压缩帧） */
function encodeIco(frames) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(frames.length, 4)

  const dir = Buffer.alloc(16 * frames.length)
  let offset = 6 + dir.length
  const blobs = []
  frames.forEach((frame, index) => {
    const o = index * 16
    dir[o] = frame.size >= 256 ? 0 : frame.size // 0 表示 256
    dir[o + 1] = frame.size >= 256 ? 0 : frame.size
    dir[o + 2] = 0 // 调色板数
    dir[o + 3] = 0
    dir.writeUInt16LE(1, o + 4) // color planes
    dir.writeUInt16LE(32, o + 6) // bits per pixel
    dir.writeUInt32BE(0, o + 8)
    dir.writeUInt32LE(frame.png.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += frame.png.length
    blobs.push(frame.png)
  })

  return Buffer.concat([header, dir, ...blobs])
}

// ---------------------------------------------------------------- 主流程

const master = render(MASTER)
const frames = SIZES.map((size) => ({
  size,
  png: encodePng(size === MASTER ? master : downsample(master, MASTER, size), size),
}))

mkdirSync(OUT_DIR, { recursive: true })
const icoPath = path.join(OUT_DIR, 'icon.ico')
writeFileSync(icoPath, encodeIco(frames))
writeFileSync(path.join(OUT_DIR, 'icon.png'), frames.find((f) => f.size === 256).png)

console.log(`[icon] ${icoPath} (${frames.map((f) => `${f.size}:${f.png.length}B`).join(' ')})`)
console.log(`[icon] ${path.join(OUT_DIR, 'icon.png')}`)
