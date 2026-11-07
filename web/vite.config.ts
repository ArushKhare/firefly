import { defineConfig } from 'vite';

export default defineConfig({
  build: { target: 'es2022' }, // top-level await (grid loads before the sim starts)
  worker: { format: 'es' },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8787' },
  },
});
