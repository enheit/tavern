import { defineConfig } from "electron-vite";

// Only `main` and `preload` — the renderer is @tavern/app (external), served in dev by its own Vite
// server (TAVERN_RENDERER_URL) and in prod over the app:// scheme. Only electron + node builtins are
// external; zod and @tavern/shared are bundled into both outputs (externalizeDeps:false). Bundling
// is required: @tavern/shared is TypeScript source (extensionless imports) that Node cannot require
// at runtime, and a sandbox:true preload cannot require third-party npm modules at all.
export default defineConfig({
  main: {
    // §3.7 mac-signing fallback: release.yml exports TAVERN_MAC_UPDATES_DISABLED=1 while no Apple
    // certs exist, compiling mac auto-update OFF (updates.ts init guard).
    define: {
      __MAC_UPDATES_DISABLED__: JSON.stringify(process.env.TAVERN_MAC_UPDATES_DISABLED === "1"),
    },
    build: {
      outDir: "out/main",
      target: "node24",
      externalizeDeps: false,
      // venmicHost is the utilityProcess entry (FR-28): venmic's native PipeWire client must not
      // share the browser process (a libpipewire assert would SIGABRT the whole app), so it gets
      // its own bundle the main process forks.
      lib: { entry: { index: "src/main/index.ts", venmicHost: "src/main/venmicHost.ts" } },
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
