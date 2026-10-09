import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  base: './',
  server: { host: '127.0.0.1', port: 4175, strictPort: true },
  build: { target: 'es2022', assetsInlineLimit: 0, sourcemap: false, rollupOptions: { input: { demo: fileURLToPath(new URL('index.html', import.meta.url)), live: fileURLToPath(new URL('live.html', import.meta.url)) } } },
})
