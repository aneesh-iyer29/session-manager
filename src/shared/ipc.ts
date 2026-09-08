/**
 * IPC contract. The preload script exposes exactly this API as `window.swapper`;
 * the main process registers one `ipcMain.handle` per channel. Errors thrown in
 * main surface in the renderer as rejected promises whose `message` is safe to
 * show to the user (never include secrets in thrown messages).
 */
import type { AppState, LoginStatus, Settings } from './types'

export const IPC = {
  getState: 'swapper:getState',
  refresh: 'swapper:refresh',
  refreshCodex: 'swapper:refreshCodex',
  switchTo: 'swapper:switchTo',
  captureActive: 'swapper:captureActive',
  startLogin: 'swapper:startLogin',
  loginStatus: 'swapper:loginStatus',
  cancelLogin: 'swapper:cancelLogin',
  setDisabled: 'swapper:setDisabled',
  setAlias: 'swapper:setAlias',
  removeAccount: 'swapper:removeAccount',
  updateSettings: 'swapper:updateSettings',
  openExternal: 'swapper:openExternal',
  openDataFolder: 'swapper:openDataFolder',
  installHook: 'swapper:installHook',
  uninstallHook: 'swapper:uninstallHook',
  installFeed: 'swapper:installFeed',
  uninstallFeed: 'swapper:uninstallFeed',
  /** main → renderer push, payload: AppState */
  stateChanged: 'swapper:stateChanged',
} as const

export interface SwapperApi {
  getState(): Promise<AppState>
  /** Force a usage poll of every Claude account now. Codex is left alone; it has `refreshCodex`. */
  refresh(): Promise<AppState>
  /** Re-fetch the Codex snapshot now, ignoring its back-off. Rejects with the fetch error when the usage call fails. */
  refreshCodex(): Promise<AppState>
  switchTo(accountId: string): Promise<AppState>
  /** Add or update an account from the credential Claude Code is currently logged in with. */
  captureActive(): Promise<AppState>
  /** Begin a browser OAuth login; poll `loginStatus` until `done` or `error`. */
  startLogin(): Promise<LoginStatus>
  loginStatus(loginId: string): Promise<LoginStatus>
  cancelLogin(loginId: string): Promise<void>
  setDisabled(accountId: string, disabled: boolean): Promise<AppState>
  setAlias(accountId: string, alias: string): Promise<AppState>
  /** Refuses to remove the active account. */
  removeAccount(accountId: string): Promise<AppState>
  updateSettings(patch: Partial<Settings>): Promise<AppState>
  openExternal(url: string): Promise<void>
  openDataFolder(): Promise<void>
  /** Write the compact-nudge hook script and register it in ~/.claude/settings.json. */
  installHook(): Promise<AppState>
  uninstallHook(): Promise<AppState>
  /** Register the status line script that feeds the active account's usage without polling. */
  installFeed(): Promise<AppState>
  uninstallFeed(): Promise<AppState>
  /** Subscribe to state pushes. Returns an unsubscribe function. */
  onState(callback: (state: AppState) => void): () => void
}

declare global {
  interface Window {
    /** Absent when the renderer runs in a plain browser (`npm run dev:web`); use the mock then. */
    swapper?: SwapperApi
  }
}
