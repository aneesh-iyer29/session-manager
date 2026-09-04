/**
 * The one dashboard window. Closing it only hides it: the daemon keeps polling
 * and the tray item stays, which is the whole point of a menu-bar utility.
 */
import { BrowserWindow, app, nativeTheme, shell } from 'electron'
import { fileURLToPath } from 'node:url'

let win: BrowserWindow | null = null

/** Origins the renderer may open with a plain link click; everything else goes to the default browser. */
const RENDERER_URL = process.env.ELECTRON_RENDERER_URL

/** True for the bundled renderer file and, in development, the Vite dev server origin. */
function isOwnUrl(url: string): boolean {
  if (url.startsWith('file:')) return true
  if (!app.isPackaged && RENDERER_URL) {
    try {
      return new URL(url).origin === new URL(RENDERER_URL).origin
    } catch {
      return false
    }
  }
  return false
}

export function getWindow(): BrowserWindow | null {
  return win
}

export function createWindow(): BrowserWindow {
  if (win && !win.isDestroyed()) return win
  win = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 860,
    minHeight: 600,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    // Solid paper ground, matching the renderer's --bg in each appearance; no vibrancy.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1a18' : '#fbfaf7',
    webPreferences: {
      preload: fileURLToPath(new URL('../preload/index.mjs', import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      // ESM preload scripts cannot run in the renderer sandbox; contextIsolation still applies.
      sandbox: false,
    },
  })

  win.once('ready-to-show', () => win?.show())

  // Hide instead of closing so the app keeps running in the tray; ⌘Q sets isQuitting.
  win.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    win?.hide()
  })
  win.on('closed', () => {
    win = null
  })

  // Any window.open / target=_blank from the renderer opens externally, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // The window only ever shows the bundled renderer (or the dev server); a
  // navigation anywhere else would hand the preload bridge to foreign content.
  win.webContents.on('will-navigate', (event, url) => {
    if (isOwnUrl(url)) return
    event.preventDefault()
    if (/^https?:/.test(url)) void shell.openExternal(url)
  })

  if (!app.isPackaged && RENDERER_URL) {
    void win.loadURL(RENDERER_URL)
  } else {
    void win.loadFile(fileURLToPath(new URL('../renderer/index.html', import.meta.url)))
  }
  return win
}

/** Bring the window to the front, creating it if the user closed it earlier. */
export function showWindow(): void {
  const w = createWindow()
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
}

let isQuitting = false

/** Called from `before-quit` so the close handler lets the window actually close. */
export function markQuitting(): void {
  isQuitting = true
}
