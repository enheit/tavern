import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { playwright } from '@vitest/browser-playwright';

// Vitest 4 browser mode: real Chromium via the Playwright provider (headless).
export default defineConfig({
  plugins: [svelte()],
  test: {
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: 'chromium' }],
    },
    coverage: {
      provider: 'istanbul',
      include: ['src/**/*.{ts,svelte}'],
      // Boot glue (mounts to the DOM) and generated type-only protocol files have
      // no meaningfully testable logic — excluded like the worker's src/protocol.
      exclude: ['src/main.ts', 'src/lib/protocol/**'],
      reporter: ['text', 'json'],
      // App coverage gate flips ON at S3.1 (§1 Coverage row: app lines >=70%).
      thresholds: { lines: 70 },
    },
  },
});
