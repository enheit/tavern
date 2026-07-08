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
      reporter: ['text', 'json'],
      // Gate (app lines >=70%) enforcement flips on at S2.1.
    },
  },
});
