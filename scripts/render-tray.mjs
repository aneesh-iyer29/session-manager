/**
 * Rasterize build/tray.svg into the two template PNGs the menu bar item needs.
 *
 * Run with: npx electron scripts/render-tray.mjs
 *
 * Why Electron: macOS template images must be black with real alpha, and the
 * system thumbnailer (qlmanage) flattens SVGs onto white. An offscreen,
 * transparent BrowserWindow renders the SVG exactly as Chromium would; the
 * offscreen `paint` event hands over the composited frame with its alpha.
 * One 64 px render is downsampled to 32 (@2x) and 16 (@1x).
 */
import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const svg = readFileSync(join(root, 'build', 'tray.svg'), 'utf8')
const SIZE = 64

function renderOnce() {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      show: false,
      width: SIZE,
      height: SIZE,
      transparent: true,
      frame: false,
      backgroundColor: '#00000000',
      webPreferences: { offscreen: true, sandbox: false },
    })
    win.webContents.setFrameRate(10)
    let done = false
    win.webContents.on('paint', (_event, _dirty, image) => {
      if (done) return
      const { width, height } = image.getSize()
      // Wait for a full-window frame; offscreen mode may emit partial dirty rects first.
      if (width < SIZE || height < SIZE) return
      done = true
      resolve(image)
      win.destroy()
    })
    win.webContents.on('render-process-gone', (_e, details) => reject(new Error(`renderer gone: ${details.reason}`)))
    const html =
      `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:transparent}</style></head>` +
      `<body>${svg.replace(/<svg /, `<svg style="display:block" width="${SIZE}" height="${SIZE}" `)}</body></html>`
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).catch(reject)
    setTimeout(() => reject(new Error('no paint event within 5 s')), 5000)
  })
}

app.dock?.hide()
app
  .whenReady()
  .then(async () => {
    const image = await renderOnce()
    const out = [
      [16, 'trayTemplate.png'],
      [32, 'trayTemplate@2x.png'],
    ]
    for (const [px, name] of out) {
      const resized = image.resize({ width: px, height: px, quality: 'best' })
      const path = join(root, 'build', name)
      writeFileSync(path, resized.toPNG())
      console.log(`wrote ${path} ${resized.getSize().width}x${resized.getSize().height}`)
    }
    app.exit(0)
  })
  .catch((err) => {
    console.error(err)
    app.exit(1)
  })
