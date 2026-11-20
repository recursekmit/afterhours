import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const API = process.env.API_URL ?? 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectRegister: false,
      // Our own web/public/manifest.webmanifest is the source of truth.
      manifest: false,
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,woff2,png,svg,webmanifest}'],
        // iOS reads launch images itself at install time; no need to make every phone download them.
        // The jsQR fallback is fetched only by browsers without BarcodeDetector (iPhone Safari, desk laptops), when they scan.
        globIgnores: ['**/icons/splash-*.png', '**/assets/jsQR-*.js'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': { target: API, changeOrigin: false },
    },
  },
  preview: {
    port: 4173,
    proxy: { '/api': { target: API } },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    assetsInlineLimit: 0,
  },
});
