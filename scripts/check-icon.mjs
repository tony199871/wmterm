// 校验生成的 .ico 结构：目录项、每帧 PNG 签名与 IHDR 尺寸
import { readFileSync } from 'node:fs'

const file = process.argv[2]
const buf = readFileSync(file)
console.log(`file=${file} bytes=${buf.length} type=${buf.readUInt16LE(2)} count=${buf.readUInt16LE(4)}`)
const count = buf.readUInt16LE(4)
for (let i = 0; i < count; i += 1) {
  const o = 6 + i * 16
  const w = buf[o] || 256
  const h = buf[o + 1] || 256
  const len = buf.readUInt32LE(o + 8)
  const off = buf.readUInt32LE(o + 12)
  const png = buf.subarray(off, off + 8)
  const magicOk = png.toString('hex') === '89504e470d0a1a0a'
  const ihdrW = buf.readUInt32BE(off + 16)
  const ihdrH = buf.readUInt32BE(off + 20)
  const bitDepth = buf[off + 24]
  const colorType = buf[off + 25]
  console.log(
    `  ${String(w).padStart(3)}x${String(h).padEnd(3)} len=${String(len).padStart(5)} off=${String(off).padStart(6)} png=${magicOk} ihdr=${ihdrW}x${ihdrH} depth=${bitDepth} color=${colorType}`,
  )
}
