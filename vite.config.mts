import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: resolve(import.meta.dirname, 'src'),
  base: './',
  build: {
    outDir: resolve(import.meta.dirname, 'dist/renderer'),
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        index: resolve(import.meta.dirname, 'src/index.html'),
        results: resolve(import.meta.dirname, 'src/results.html'),
        devices: resolve(import.meta.dirname, 'src/devices.html'),
        onboarding: resolve(import.meta.dirname, 'src/onboarding.html'),
        privacy: resolve(import.meta.dirname, 'src/privacy.html'),
      },
    },
  },
  test: { root: import.meta.dirname, include: ['test/**/*.test.ts'], environment: 'node' },
});
