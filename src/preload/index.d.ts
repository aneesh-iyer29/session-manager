/**
 * Renderer-side typing for the preload bridge. The shape is `SwapperApi` from
 * `src/shared/ipc.ts`, which also declares the `window.swapper` global; this
 * file re-exports the type so renderer code can import it from the preload
 * without reaching into `shared` for the IPC channel names.
 */
import type { SwapperApi } from '../shared/ipc'

export type { SwapperApi }

declare global {
  interface Window {
    /** Absent when the renderer runs in a plain browser (`npm run dev:web`); use the mock then. */
    swapper?: SwapperApi
  }
}
