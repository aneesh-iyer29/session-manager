/**
 * Preload bridge: exposes exactly `SwapperApi` as `window.swapper`. Each method
 * is a thin `ipcRenderer.invoke`; the renderer never sees `ipcRenderer` itself.
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { IPC } from '../shared/ipc'
import type { SwapperApi } from '../shared/ipc'
import type { AppState, Settings } from '../shared/types'

const api: SwapperApi = {
  getState: () => ipcRenderer.invoke(IPC.getState),
  refresh: () => ipcRenderer.invoke(IPC.refresh),
  refreshCodex: () => ipcRenderer.invoke(IPC.refreshCodex),
  switchTo: (accountId: string) => ipcRenderer.invoke(IPC.switchTo, accountId),
  captureActive: () => ipcRenderer.invoke(IPC.captureActive),
  startLogin: () => ipcRenderer.invoke(IPC.startLogin),
  loginStatus: (loginId: string) => ipcRenderer.invoke(IPC.loginStatus, loginId),
  cancelLogin: (loginId: string) => ipcRenderer.invoke(IPC.cancelLogin, loginId),
  setDisabled: (accountId: string, disabled: boolean) => ipcRenderer.invoke(IPC.setDisabled, accountId, disabled),
  setAlias: (accountId: string, alias: string) => ipcRenderer.invoke(IPC.setAlias, accountId, alias),
  removeAccount: (accountId: string) => ipcRenderer.invoke(IPC.removeAccount, accountId),
  updateSettings: (patch: Partial<Settings>) => ipcRenderer.invoke(IPC.updateSettings, patch),
  openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url),
  openDataFolder: () => ipcRenderer.invoke(IPC.openDataFolder),
  installHook: () => ipcRenderer.invoke(IPC.installHook),
  uninstallHook: () => ipcRenderer.invoke(IPC.uninstallHook),
  installFeed: () => ipcRenderer.invoke(IPC.installFeed),
  uninstallFeed: () => ipcRenderer.invoke(IPC.uninstallFeed),
  onState: (callback: (state: AppState) => void) => {
    const listener = (_event: IpcRendererEvent, state: AppState): void => callback(state)
    ipcRenderer.on(IPC.stateChanged, listener)
    return () => ipcRenderer.removeListener(IPC.stateChanged, listener)
  },
}

contextBridge.exposeInMainWorld('swapper', api)
