/**
 * Menu bar item: the Arcophos mark alone, no title. Clicking it opens a glance
 * menu — usage bars for every account and Codex, one status line — and two
 * actions: open the app, quit. Everything else (switching, toggles) lives in
 * the window on purpose, so the menu can never change state by accident.
 */
import { Menu, Tray, app, nativeImage } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { readFileSync } from 'node:fs'
import type { AppState } from '../shared/types'
import trayIcon1x from '../../build/trayTemplate.png?asset'
import trayIcon2x from '../../build/trayTemplate@2x.png?asset'
import { accountHeader, codexHeader, orderedWindows, statusLine, windowLine } from './trayText'

export interface TrayActions {
  open: () => void
  quit: () => void
}

let tray: Tray | null = null
let latest: AppState | null = null
let currentActions: TrayActions | null = null

/**
 * Both scale factors are added explicitly: electron-vite hashes asset file
 * names, so Electron's automatic `@2x` sibling lookup would not find the retina one.
 */
function templateImage(): Electron.NativeImage {
  const img = nativeImage.createEmpty()
  img.addRepresentation({ scaleFactor: 1, buffer: readFileSync(trayIcon1x) })
  img.addRepresentation({ scaleFactor: 2, buffer: readFileSync(trayIcon2x) })
  img.setTemplateImage(true)
  return img
}

/** Information rows are enabled (so they render in full contrast) and open the app when clicked. */
function info(label: string, open: () => void): MenuItemConstructorOptions {
  return { label, click: open }
}

function buildMenu(state: AppState, actions: TrayActions, now: Date): Menu {
  const items: MenuItemConstructorOptions[] = []
  if (state.accounts.length === 0) {
    items.push(info('No accounts yet — open Session Manager to add one', actions.open))
  }
  for (const acc of state.accounts) {
    items.push(info(accountHeader(acc), actions.open))
    const windows = orderedWindows(acc)
    if (windows.length === 0) {
      items.push(info(`    ${acc.usage?.error ?? 'usage not fetched yet'}`, actions.open))
    }
    for (const w of windows) items.push(info(`    ${windowLine(w, now)}`, actions.open))
    items.push({ type: 'separator' })
  }
  if (state.settings.codexEnabled) {
    items.push(info(codexHeader(state.codex), actions.open))
    if (state.codex.usage) {
      for (const w of orderedWindows({ usage: state.codex.usage })) items.push(info(`    ${windowLine(w, now)}`, actions.open))
    }
    items.push({ type: 'separator' })
  }
  items.push(info(statusLine(state, now), actions.open))
  items.push({ type: 'separator' })
  items.push({ label: 'Open Session Manager', accelerator: 'CmdOrCtrl+O', click: actions.open })
  items.push({ label: `Quit Session Manager ${app.getVersion()}`, accelerator: 'CmdOrCtrl+Q', click: actions.quit })
  return Menu.buildFromTemplate(items)
}

/** Build the menu at click time so countdowns and "polled Ns ago" are current. */
function popup(): void {
  if (!tray || !latest || !currentActions) return
  tray.popUpContextMenu(buildMenu(latest, currentActions, new Date()))
}

export function createTray(actions: TrayActions): Tray {
  if (tray) return tray
  currentActions = actions
  tray = new Tray(templateImage())
  tray.setToolTip('Session Manager')
  tray.setTitle('')
  tray.on('click', popup)
  tray.on('right-click', popup)
  return tray
}

export function updateTray(state: AppState, actions: TrayActions): void {
  latest = state
  currentActions = actions
}

export function hasTray(): boolean {
  return tray !== null && !tray.isDestroyed()
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
  latest = null
}
