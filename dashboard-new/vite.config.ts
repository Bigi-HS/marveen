/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// New read-only dashboard (card 513b8fd6). Runs on :3421 and proxies every
// /api/* call to the existing backend on :3420 (single-writer invariant: the UI
// never opens the SQLite DB). The proxy keeps the browser same-origin in dev, so
// no CORS handshake is needed for F0 (CORS lands in F1 with the SSE stream).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  server: {
    port: 3421,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3420',
        changeOrigin: true,
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
})
