import { defineConfig } from 'vite';

export default defineConfig({
  base: '/thsrc-expense-report/',
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  optimizeDeps: { exclude: ['@neslinesli93/qpdf-wasm'] },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
} as never);
