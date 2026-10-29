import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('.', import.meta.url)));

export default defineConfig({
  root: resolve(projectRoot, 'src/client'),
  publicDir: resolve(projectRoot, 'public'),
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  build: {
    outDir: resolve(projectRoot, 'dist/client'),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: { output: { manualChunks: { react: ['react', 'react-dom'] } } },
  },
  server: { host: '0.0.0.0', port: 5173 },
});
