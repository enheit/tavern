import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
    coverage: {
      // enabled so the verbatim DoD command `pnpm -F @tavern/app test -- --coverage` (which pnpm
      // expands to `vitest run -- --coverage`, making `--coverage` a positional) still runs
      // coverage and enforces the pinned threshold (S4.1 precedent).
      enabled: true,
      provider: "istanbul",
      include: ["src/**"],
      exclude: ["src/paraglide/**", "src/components/ui/**"],
      thresholds: { lines: 70 },
    },
  },
});
