import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/**
 * 渲染层构建配置。
 * - base: './' 让打包后的 file:// 协议能正确加载相对资源。
 * - target: 'chrome128' 与 Electron 33 内置 Chromium 对齐，产出更小更快的代码。
 * - 渲染层为独立构建，绝不把 Node 内置模块打进包里（contextIsolation 下无 Node 权限）。
 */
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  publicDir: false,
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome120',
    sourcemap: false,
    cssTarget: 'chrome120',
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      input: resolve(__dirname, 'src/renderer/index.html'),
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
