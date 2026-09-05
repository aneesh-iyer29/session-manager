/**
 * Menu bar item: the Arcophos mark alone, no title. Clicking it opens a glance
 * menu — a usage bar per window for every account and Codex, one status line —
 * and two actions: open the app, quit. Everything else (switching, toggles)
 * lives in the window on purpose, so the menu can never change state by accident.
 *
 * Rows are pictures (see trayRender.ts) so they can carry a real bar; if the
 * offscreen renderer fails, the same rows fall back to text.
 */
import { Menu, Tray, app, nativeImage, nativeTheme } from 'electron'
import type { MenuItemConstructorOptions, NativeImage } from 'electron'
import { readFileSync } from 'node:fs'
import type { AppState } from '../shared/types'
import trayIcon1x from '../../build/trayTemplate.png?asset'
import trayIcon2x from '../../build/trayTemplate@2x.png?asset'
import { renderMenu } from './trayRender'
import { menuRows, rowText, type MenuRow } from './trayText'

export interface TrayActions {
  open: () => void
  quit: () => void
}

let tray: Tray | null = null
let latest: AppState | null = null
let currentActions: TrayActions | null = null
let menu: Menu | null = null
let lastFrame: NativeImage | null = null
let renderSeq = 0

/**
 * Both scale factors are added explicitly: electron-vite hashes asset file
 * names, so Electron's automatic `@2x` sibling lookup would not find the retina one.
 */
function templateImage(): NativeImage {
  const img = nativeImage.createEmpty()
  img.addRepresentation({ scaleFactor: 1, buffer: readFileSync(trayIcon1x) })
  img.addRepresentation({ scaleFactor: 2, buffer: readFileSync(trayIcon2x) })
  img.setTemplateImage(true)
  return img
}

function actionsItems(actions: TrayActions): MenuItemConstructorOptions[] {
  return [
    { type: 'separator' },
    { label: 'Open Session Manager', accelerator: 'CmdOrCtrl+O', click: actions.open },
    { label: `Quit Session Manager ${app.getVersion()}`, accelerator: 'CmdOrCtrl+Q', click: actions.quit },
  ]
}

function textMenu(rows: MenuRow[], actions: TrayActions): Menu {
  const items: MenuItemConstructorOptions[] = rows.map((row) => ({ label: rowText(row), click: actions.open }))
  return Menu.buildFromTemplate([...items, ...actionsItems(actions)])
}

function imageMenu(rows: MenuRow[], images: NativeImage[], actions: TrayActions): Menu {
  const items: MenuItemConstructorOptions[] = rows.map((row, i) => ({ label: '', icon: images[i], click: actions.open, toolTip: rowText(row) }))
  return Menu.buildFromTemplate([...items, ...actionsItems(actions)])
}

/** Rebuild on every state push; the newest render wins if several overlap. */
async function rebuild(): Promise<void> {
  if (!latest || !currentActions) return
  const state = latest
  const actions = currentActions
  const rows = menuRows(state, new Date())
  const seq = ++renderSeq
  menu = menu ?? textMenu(rows, actions)
  try {
    const rendered = await renderMenu(rows)
    if (seq !== renderSeq) return
    lastFrame = rendered.frame
    menu = imageMenu(rows, rendered.rows, actions)
  } catch {
    if (seq !== renderSeq) return
    menu = textMenu(rows, actions)
  }
}

function popup(): void {
  if (!tray || !menu) return
  tray.popUpContextMenu(menu)
}

export function createTray(actions: TrayActions): Tray {
  if (tray) return tray
  currentActions = actions
  tray = new Tray(templateImage())
  tray.setToolTip('Session Manager')
  tray.setTitle('')
  tray.on('click', popup)
  tray.on('right-click', popup)
  nativeTheme.on('updated', () => void rebuild())
  return tray
}

export function updateTray(state: AppState, actions: TrayActions): void {
  latest = state
  currentActions = actions
  void rebuild()
}

/** The last rendered menu frame, for smoke screenshots; null until the first render lands. */
export function trayFrame(): NativeImage | null {
  return lastFrame
}

export function hasTray(): boolean {
  return tray !== null && !tray.isDestroyed()
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
  latest = null
  menu = null
}
