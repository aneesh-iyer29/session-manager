/**
 * Menu bar item: "<alias> 63%" next to a template glyph, plus a menu that covers
 * the everyday actions so the window rarely needs to be opened.
 */
import { Menu, Tray, app, nativeImage } from 'electron'
import { readFileSync } from 'node:fs'
import type { Account, AppState } from '../shared/types'
import trayIcon1x from '../../build/trayTemplate.png?asset'
import trayIcon2x from '../../build/trayTemplate@2x.png?asset'

export interface TrayActions {
  open: () => void
  refresh: () => void
  switchTo: (accountId: string) => void
  setAutoswap: (enabled: boolean) => void
  setLaunchAtLogin: (enabled: boolean) => void
  quit: () => void
}

let tray: Tray | null = null

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

function shortName(acc: Account): string {
  return acc.alias || acc.email.split('@')[0] || acc.id
}

function trayTitle(state: AppState): string {
  const active = state.accounts.find((a) => a.active)
  if (!active) return ''
  const binding = active.usage?.windows.find((w) => w.key === active.bindingWindow)
  const pct = binding ? `${Math.round(binding.pct)}%` : active.headroom === null ? '–' : `${Math.round(100 - active.headroom)}%`
  return `${shortName(active)} ${pct}`
}

function accountLabel(acc: Account): string {
  const room = acc.headroom === null ? 'usage unknown' : `${Math.round(acc.headroom)}% headroom`
  const flags = [acc.active ? 'active' : '', acc.disabled ? 'held' : '', acc.tokenStatus === 'dead' ? 'needs login' : '']
    .filter(Boolean)
    .join(', ')
  return `${shortName(acc)} — ${room}${flags ? ` (${flags})` : ''}`
}

export function createTray(actions: TrayActions): Tray {
  if (tray) return tray
  tray = new Tray(templateImage())
  tray.setToolTip('Claude Swapper')
  tray.on('click', actions.open)
  return tray
}

export function updateTray(state: AppState, actions: TrayActions): void {
  if (!tray) return
  tray.setTitle(trayTitle(state), { fontType: 'monospacedDigit' })
  const accounts = state.accounts.map((acc) => ({
    label: accountLabel(acc),
    enabled: !acc.active && acc.tokenStatus !== 'dead',
    click: () => actions.switchTo(acc.id),
  }))
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Claude Swapper', click: actions.open },
      { label: 'Refresh now', click: actions.refresh },
      {
        label: 'Accounts',
        submenu: accounts.length ? accounts : [{ label: 'No accounts yet', enabled: false }],
      },
      { type: 'separator' },
      {
        label: 'Auto-swap',
        type: 'checkbox',
        checked: state.settings.autoswapEnabled,
        click: (item) => actions.setAutoswap(item.checked),
      },
      {
        label: 'Launch at login',
        type: 'checkbox',
        checked: state.settings.launchAtLogin,
        click: (item) => actions.setLaunchAtLogin(item.checked),
      },
      { type: 'separator' },
      { label: `Quit Claude Swapper ${app.getVersion()}`, click: actions.quit },
    ]),
  )
}

export function hasTray(): boolean {
  return tray !== null && !tray.isDestroyed()
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
