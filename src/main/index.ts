/**
 * Electron entry point: wires the store, the daemon, the window, the tray, and
 * IPC together. Everything with behaviour lives in the modules it imports; this
 * file only decides the order things start in and how the app quits.
 */
import { BrowserWindow, Notification, app, shell } from 'electron'
import { writeFileSync } from 'node:fs'
import { Daemon } from './daemon'
import { broadcastState, registerIpc } from './ipc'
import { dataDir, setDataDir } from './paths'
import { Store } from './store'
import { createTray, destroyTray, hasTray, updateTray } from './tray'
import { createWindow, markQuitting, showWindow } from './window'
import type { AppState } from '../shared/types'

// A second instance would fight the first over the Keychain; hand off and exit.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showWindow)
  app.setName('Claude Swapper')
  void app.whenReady().then(main)
}

function notify(title: string, body: string): void {
  if (Notification.isSupported()) new Notification({ title, body }).show()
}

/**
 * Apply the two settings that live in the OS rather than in the window. The
 * login item is only touched when it actually differs from what macOS reports:
 * registering one from an unpackaged build fails with "Operation not permitted".
 */
function applySystemSettings(state: AppState, previous: AppState | null): void {
  const { launchAtLogin, showInDock } = state.settings
  if (previous?.settings.launchAtLogin !== launchAtLogin) {
    const registered = app.getLoginItemSettings().openAtLogin
    if (registered !== launchAtLogin) app.setLoginItemSettings({ openAtLogin: launchAtLogin })
  }
  if (previous?.settings.showInDock !== showInDock && process.platform === 'darwin') {
    if (showInDock) void app.dock?.show()
    else app.dock?.hide()
  }
}

function main(): void {
  if (!process.env.CLAUDE_SWAPPER_HOME) setDataDir(app.getPath('userData'))
  const store = new Store(dataDir())
  const daemon = new Daemon({
    store,
    version: app.getVersion(),
    deps: { openUrl: (url) => void shell.openExternal(url), notify },
  })

  const trayActions = {
    open: showWindow,
    refresh: () => void daemon.refresh(true).catch(() => undefined),
    switchTo: (id: string) => void daemon.switchTo(id).catch((err: unknown) => notify('Switch failed', String(err instanceof Error ? err.message : err))),
    setAutoswap: (enabled: boolean) => daemon.updateSettings({ autoswapEnabled: enabled }),
    setLaunchAtLogin: (enabled: boolean) => daemon.updateSettings({ launchAtLogin: enabled }),
    quit: () => app.quit(),
  }

  registerIpc(daemon)
  createTray(trayActions)

  let previous: AppState | null = null
  daemon.on('state', (state) => {
    applySystemSettings(state, previous)
    updateTray(state, trayActions)
    broadcastState(state)
    previous = state
  })

  const initial = daemon.getState()
  applySystemSettings(initial, null)
  updateTray(initial, trayActions)
  previous = initial

  // Launched at login we stay in the menu bar; a user-initiated launch shows the dashboard.
  const openedAtLogin = app.getLoginItemSettings().wasOpenedAtLogin
  if (!openedAtLogin) createWindow()
  daemon.start()

  app.on('activate', showWindow)
  app.on('before-quit', () => {
    markQuitting()
    daemon.stop()
    destroyTray()
  })
  // With the window hidden there are no windows; the default would quit us.
  app.on('window-all-closed', () => undefined)

  // Headless smoke test (`npm run smoke`): report what came up, then quit.
  const smokeMs = Number(process.env.CLAUDE_SWAPPER_SMOKE_MS)
  if (smokeMs > 0) setTimeout(() => void smokeReport(daemon).finally(() => app.quit()), smokeMs)
}

/**
 * One line of facts for the smoke script, plus an optional screenshot. The
 * renderer's text length is the cheapest proof that the page mounted and the
 * preload bridge answered; a CSP or IPC failure leaves the body empty.
 */
async function smokeReport(daemon: Daemon): Promise<void> {
  const state = daemon.getState()
  const win = BrowserWindow.getAllWindows()[0]
  let rendererChars = -1
  if (win) {
    try {
      const text: unknown = await win.webContents.executeJavaScript('document.body.innerText')
      rendererChars = typeof text === 'string' ? text.length : -1
      const png = process.env.CLAUDE_SWAPPER_SMOKE_PNG
      if (png) writeFileSync(png, (await win.capturePage()).toPNG())
    } catch (err) {
      console.error(`smoke: renderer probe failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  console.log(
    `smoke: windows=${BrowserWindow.getAllWindows().length} tray=${hasTray() ? 1 : 0} rendererChars=${rendererChars} ` +
      `accounts=${state.accounts.length} events=${state.events.length} lastPollAt=${state.polling.lastPollAt}`,
  )
}
