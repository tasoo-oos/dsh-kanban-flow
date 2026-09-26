import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // Same alias as tsconfig.json / build.mjs — tests may import client modules
    // that use "@/..." internally.
    alias: { '@': new URL('./src/client', import.meta.url).pathname },
  },
  test: {
    include: ['test/**/*.test.js'],
    environment: 'node',
  },
})
