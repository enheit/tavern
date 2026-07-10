import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // enabled here (not only via --coverage): the DoD gate runs `vitest run -- --coverage`, but
    // vitest's cac parser treats the flag after `--` as a positional, so coverage would otherwise
    // never run. Enabling it in config makes the pinned command enforce the pinned ≥70% threshold.
    coverage: {
      enabled: true,
      provider: "istanbul",
      include: ["src/**"],
      thresholds: { lines: 70 },
    },
  },
});
