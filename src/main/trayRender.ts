/**
 * Renders the glance-menu rows as images. NSMenu items are text or an icon, so
 * a row with a real bar has to be a picture: one offscreen, transparent
 * BrowserWindow paints every row at 2× in a single frame, and the frame is
 * cropped into per-row NativeImages with scaleFactor 2. Rendering happens on
 * state change, never on click, so the menu opens instantly.
 */
import { BrowserWindow, nativeImage, nativeTheme } from 'electron'
import type { NativeImage } from 'electron'
import { rowsHtml, type MenuRow, ROW_HEIGHT, ROW_WIDTH } from './trayText'

const SCALE = 2
const TIMEOUT_MS = 4000

export interface RenderedMenu {
  rows: NativeImage[]
  /** The whole frame, for smoke screenshots. */
  frame: NativeImage
}

function totalHeight(rows: MenuRow[]): number {
  return rows.reduce((sum, r) => sum + ROW_HEIGHT[r.kind], 0)
}

/** Resolve with the first full-size frame painted after the document loads. */
function paintOnce(rows: MenuRow[], dark: boolean): Promise<NativeImage> {
  const width = ROW_WIDTH * SCALE
  const height = Math.max(1, totalHeight(rows)) * SCALE
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      show: false,
      width,
      height,
      transparent: true,
      frame: false,
      backgroundColor: '#00000000',
      webPreferences: { offscreen: true, sandbox: false, contextIsolation: true, nodeIntegration: false },
    })
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
      if (!win.isDestroyed()) win.destroy()
    }
    const timer = setTimeout(() => finish(() => reject(new Error('tray render timed out'))), TIMEOUT_MS)
    let loaded = false
    win.webContents.setFrameRate(10)
    win.webContents.on('did-finish-load', () => {
      loaded = true
      win.webContents.invalidate()
    })
    win.webContents.on('paint', (_event, _dirty, image) => {
      if (!loaded) return
      const size = image.getSize()
      if (size.width < width || size.height < height) return
      finish(() => resolve(image))
    })
    win.webContents.on('render-process-gone', (_e, d) => finish(() => reject(new Error(`tray renderer gone: ${d.reason}`))))
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(rowsHtml(rows, dark, SCALE))).catch((err) => finish(() => reject(err)))
  })
}

export async function renderMenu(rows: MenuRow[]): Promise<RenderedMenu> {
  const dark = nativeTheme.shouldUseDarkColors
  const frame = await paintOnce(rows, dark)
  const images: NativeImage[] = []
  let y = 0
  for (const row of rows) {
    const h = ROW_HEIGHT[row.kind]
    const crop = frame.crop({ x: 0, y: y * SCALE, width: ROW_WIDTH * SCALE, height: h * SCALE })
    images.push(nativeImage.createFromBuffer(crop.toPNG(), { scaleFactor: SCALE }))
    y += h
  }
  return { rows: images, frame }
}
