import path from "node:path";
import { paraglideVitePlugin } from "@inlang/paraglide-js";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
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
