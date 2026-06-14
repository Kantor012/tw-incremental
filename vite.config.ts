import { defineConfig } from 'vite'

// Project Pages live under https://Kantor012.github.io/tw-incremental/
// so the production base must match the repo path. Dev stays at root.
export default defineConfig(({ mode }) => ({
  base: mode === 'production' ? '/tw-incremental/' : '/',
  build: {
    target: 'es2020',
    outDir: 'dist',
    sourcemap: false,
  },
}))
