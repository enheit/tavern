import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    // S10.1 pins its unit tests colocated in `src/` (so their `describe('FR-39 …')` strings count in
    // the `grep app/src e2e` traceability gate); earlier steps colocate under `test/`. Scan both.
    include: ["test/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
    coverage: {
      // enabled so the verbatim DoD command `pnpm -F @tavern/app test -- --coverage` (which pnpm
      // expands to `vitest run -- --coverage`, making `--coverage` a positional) still runs
      // coverage and enforces the pinned threshold (S4.1 precedent).
      enabled: true,
      provider: "istanbul",
      include: ["src/**"],
      exclude: ["src/paraglide/**", "src/components/ui/**", "src/**/*.test.{ts,tsx}"],
      // Per-glob gate for the media engine (PLAN §10: app/src/media ≥85%), additive to the overall
      // ≥70% line threshold from S4.2/S4.3. Vitest resolves threshold globs relative to this config's
      // root (the app package), so the files appear as `src/media/…`; the DoD-pinned `app/src/media/**`
      // matches nothing here (verified: the gate is then vacuous), so the glob is anchored with `**/`
      // to actually enforce — the DoD's stated intent ("fail if app/src/media drops below 85%").
      thresholds: { lines: 70, "**/src/media/**": { lines: 85 } },
    },
  },
});
