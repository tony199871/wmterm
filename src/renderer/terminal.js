import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'

const THEME = {
  background: '#0f1116',
  foreground: '#d5dae3',
  cursor: '#7dd3fc',
  cursorAccent: '#0f1116',
  selectionBackground: 'rgba(125, 211, 252, 0.28)',
  black: '#1b1f27',
  red: '#f87171',
  green: '#7ee787',
  yellow: '#f0c674',
  blue: '#79b8ff',
  magenta: '#d2a8ff',
  cyan: '#76e4f7',
  white: '#d5dae3',
  brightBlack: '#5b6472',
  brightRed: '#ff9c9c',
  brightGreen: '#a5f3a0',
  brightYellow: '#ffe08a',
  brightBlue: '#a3d4ff',
  brightMagenta: '#e5c4ff',
  brightCyan: '#a5f3fc',
  brightWhite: '#f4f7fb',
}

export function createTerminal({ onData, onTitle, onResize, onBell }) {
  const term = new Terminal({
    allowProposedApi: true,
    convertEol: false,
    cursorBlink: true,
    cursorStyle: 'bar',
    drawBoldTextInBrightColors: true,
    fontFamily: '"Cascadia Mono", "Cascadia Code", "JetBrains Mono", Consolas, "Microsoft YaHei Mono", monospace',
    fontSize: 13,
    lineHeight: 1.2,
    letterSpacing: 0,
    macOptionIsMeta: false,
    minimumContrastRatio: 1,
    rightClickSelectsWord: false,
    scrollback: 20000,
    smoothScrollDuration: 0,
    theme: THEME,
  })

  const fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  try {
    term.loadAddon(new WebLinksAddon())
  } catch {
    /* 可选插件，失败不影响终端 */
  }

  term.onData((data) => onData(data))
  term.onResize(({ cols, rows }) => onResize(cols, rows))
  term.onTitleChange((title) => onTitle(title))
  term.onBell(() => onBell?.())

  return { term, fitAddon }
}
