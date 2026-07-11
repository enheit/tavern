import path from "node:path";
import { paraglideVitePlugin } from "@inlang/paraglide-js";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { createLogger, defineConfig } from "vite";

// A closing page (every e2e teardown) kills its room WebSocket mid-write; the /api ws proxy
// surfaces that as EPIPE/ECONNRESET and vite prints a full stack — twice — per socket, drowning
// the test output. Only that exact expected socket-lifecycle noise is dropped; every other proxy
// error (unknown codes, http proxy errors) still logs.
const logger = createLogger();
const originalError = logger.error.bind(logger);
logger.error = (msg, options) => {
  if (
    typeof msg === "string" &&
    msg.includes("ws proxy") &&
    (msg.includes("EPIPE") || msg.includes("ECONNRESET"))
  ) {
    return;
  }
  originalError(msg, options);
};

export default defineConfig({
  customLogger: logger,
  plugins: [
    react(),
    tailwindcss(),
    paraglideVitePlugin({
      project: "./project.inlang",
      outdir: "./src/paraglide",
      strategy: ["localStorage", "baseLocale"],
      // Emit .d.ts alongside the generated .js so strict TS (`tsc --noEmit`) can type the
      // `@/paraglide/*.js` imports — without declarations they resolve to implicit `any`.
      emitTsDeclarations: true,
    }),
  ],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: "http://localhost:8787", ws: true } },
  },
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  build: { target: "es2022" },
});
