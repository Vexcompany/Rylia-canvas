import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 5173, open: false },
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      output: {
        // The HEIC decoder ships as an asset (see src/io/heif-read.js) and is
        // published as `.mjs`. Plenty of servers — nginx's own mime.types among
        // them — do not know that extension, serve it as octet-stream, and the
        // browser refuses to run a module of that type. `.js` works everywhere.
        assetFileNames: (asset) => (/\.mjs$/.test(asset.names?.[0] || asset.name || '')
          ? 'assets/[name]-[hash].js'
          : 'assets/[name]-[hash][extname]'),
      },
    },
  },
});
