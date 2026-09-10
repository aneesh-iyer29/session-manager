/**
 * One `ipcMain.handle` per channel in `src/shared/ipc.ts`. Arguments are
 * type-checked here because the renderer is a separate process: a stale or
 * hostile page must not be able to feed the daemon garbage. Errors are
 * rethrown as plain `Error`s so only their message crosses the bridge.
 */
import { BrowserWindow, ipcMain, shell } from 'electron'
import { IPC } from '../shared/ipc'
import type { AppState, Settings } from '../shared/types'
import type { Daemon } from './daemon'
import { dataDir } from './paths'

const SETTING_KEYS: ReadonlySet<string> = new Set([
  'autoswapEnabled',
  'dryRun',
  'fiveHourThreshold',
  'threshold',
  'margin',
  'cooldownSeconds',
  'pollIntervalSeconds',
  'strategy',
  'model',
  'codexEnabled',
  'notify',
  'launchAtLogin',
  'showInDock',
  'warnPct',
  'nudgeMode',
])

function str(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${name} must be a non-empty string`)
  return value
}

function bool(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`)
  return value
}

function settingsPatch(value: unknown): Partial<Settings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('settings patch must be an object')
  for (const key of Object.keys(value)) {
    if (!SETTING_KEYS.has(key)) throw new Error(`unknown setting "${key}"`)
  }
  return value as Partial<Settings>
}

/** Only http(s) links leave the app; anything else (file:, javascript:) is refused. */
function httpUrl(value: unknown): string {
  const url = str(value, 'url')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('url is not valid')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('only http(s) links can be opened')
  return url
}

export function registerIpc(daemon: Daemon): void {
  // Wrap so a thrown non-Error (or an Error subclass) reaches the renderer as a clean message.
  const handle = (channel: string, fn: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
      try {
        return await fn(...args)
      } catch (err) {
        throw new Error(err instanceof Error ? err.message : String(err))
      }
    })
  }

  handle(IPC.getState, () => daemon.getState())
  handle(IPC.refresh, () => daemon.refreshClaude())
  handle(IPC.refreshCodex, () => daemon.refreshCodex())
  handle(IPC.switchTo, (id) => daemon.switchTo(str(id, 'accountId')))
  handle(IPC.captureActive, () => daemon.captureActive())
  handle(IPC.startLogin, () => daemon.startLogin())
  handle(IPC.loginStatus, (id) => daemon.loginStatus(str(id, 'loginId')))
  handle(IPC.cancelLogin, (id) => daemon.cancelLogin(str(id, 'loginId')))
  handle(IPC.setDisabled, (id, disabled) => daemon.setDisabled(str(id, 'accountId'), bool(disabled, 'disabled')))
  handle(IPC.setAlias, (id, alias) => {
    if (typeof alias !== 'string') throw new Error('alias must be a string')
    return daemon.setAlias(str(id, 'accountId'), alias)
  })
  handle(IPC.removeAccount, (id) => daemon.removeAccount(str(id, 'accountId')))
  handle(IPC.updateSettings, (patch) => daemon.updateSettings(settingsPatch(patch)))
  handle(IPC.openExternal, (url) => shell.openExternal(httpUrl(url)))
  handle(IPC.openDataFolder, () => shell.openPath(dataDir()).then(() => undefined))
  handle(IPC.installHook, () => daemon.installHook())
  handle(IPC.uninstallHook, () => daemon.uninstallHook())
  handle(IPC.installFeed, () => daemon.installFeed())
  handle(IPC.uninstallFeed, () => daemon.uninstallFeed())
}

/** Push a state snapshot to every live window; the renderer never polls. */
export function broadcastState(state: AppState): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.stateChanged, state)
  }
}
