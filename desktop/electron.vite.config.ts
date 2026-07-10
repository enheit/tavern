import { defineConfig } from "electron-vite";

// Only `main` and `preload` — the renderer is @tavern/app (external), served in dev by its own Vite
// server (TAVERN_RENDERER_URL) and in prod over the app:// scheme. Only electron + node builtins are
// external; zod and @tavern/shared are bundled into both outputs (externalizeDeps:false). Bundling
// is required: @tavern/shared is TypeScript source (extensionless imports) that Node cannot require
// at runtime, and a sandbox:true preload cannot require third-party npm modules at all.
export default defineConfig({
  main: {
    build: {
      outDir: "out/main",
      target: "node24",
      externalizeDeps: false,
      lib: { entry: "src/main/index.ts" },
      rollupOptions: { external: ["electron"] },
    },
  },
  preload: {
    // sandbox:true preloads cannot require() third-party npm modules at runtime, so zod and
    // @tavern/shared MUST be bundled in (electron + node builtins stay external). electron-vite
    // externalizes `dependencies` by default; externalizeDeps:false disables that for the preload.
    build: {
      outDir: "out/preload",
      target: "node24",
      externalizeDeps: false,
      lib: { entry: "src/preload/index.ts" },
      rollupOptions: { external: ["electron"] },
    },
  },
});
