import { resolve } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

const developmentCspPlugin = {
  name: 'development-csp',
  apply: 'serve' as const,
  transformIndexHtml(html: string): string {
    return html.replace("connect-src 'self'", "connect-src 'self' ws://localhost:* http://localhost:*")
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          libraryScanWorker: resolve('src/main/services/libraryScanWorker.ts'),
          epubMergeWorker: resolve('src/main/services/epubMergeWorker.ts'),
          epubRepairWorker: resolve('src/main/services/epubRepairWorker.ts'),
          epubPackageWorker: resolve('src/main/services/epubPackageWorker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: 'index.cjs'
        }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [vue(), developmentCspPlugin],
    resolve: {
      alias: {
        '@': resolve('src/renderer/src')
      }
    }
  }
})
