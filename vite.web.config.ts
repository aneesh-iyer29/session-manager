// Renderer-only dev server for UI work in a normal browser. The renderer falls
// back to the in-memory mock backend when `window.swapper` is absent, so the
// whole dashboard can be built and screenshotted without Electron or accounts.
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: resolve('src/renderer'),
  plugins: [react()],
  resolve: { alias: { '@shared': resolve('src/shared'), '@': resolve('src/renderer/src') } },
  server: { port: 5180, strictPort: true },
})
