/**
 * The renderer's only door to the backend. Inside Electron the preload script
 * exposes `window.swapper`; in a plain browser (`npm run dev:web`) it is absent
 * and the in-memory mock stands in, so components never know which one they
 * talk to.
 */
import type { SwapperApi } from '@shared/ipc'
import { createMockApi } from './mock/mockApi'

let instance: SwapperApi | null = null

export function getApi(): SwapperApi {
  if (!instance) instance = window.swapper ?? createMockApi()
  return instance
}

export const isElectron = (): boolean => typeof window !== 'undefined' && window.swapper !== undefined
