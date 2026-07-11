#!/usr/bin/env node
// Nightly AppImage boot proof (S12.2/PLAN §3.2): launch the built .AppImage standalone (no
// TAVERN_RENDERER_URL → it loads its own asar renderer over app://), assert the window title is
// `Tavern`, quit. Lives under e2e/ because @playwright/test is this workspace package's dependency.
// --no-sandbox: docker's default seccomp blocks the unprivileged userns Chromium's sandbox needs.
// --password-store=basic: the containers have no keyring (same reason as e2e/harness/desktop.ts).
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(here, "..", "..", "desktop", "dist-electron");

const arg = process.argv[2];
const found = readdirSync(distDir).find((f) => f.endsWith(".AppImage"));
const appImage = arg ?? (found === undefined ? undefined : path.join(distDir, found));
if (appImage === undefined) {
  console.error(`appimage-boot: no .AppImage found in ${distDir}`);
  process.exit(1);
}

console.log(`appimage-boot: launching ${appImage}`);
const app = await _electron.launch({
  executablePath: appImage,
  args: ["--no-sandbox", "--password-store=basic"],
});
const page = await app.firstWindow();
await page.waitForLoadState("domcontentloaded");
const title = await page.title();
await app.close();

if (title !== "Tavern") {
  console.error(`appimage-boot: window title was "${title}" — expected "Tavern"`);
  process.exit(1);
}
console.log("appimage-boot: window title 'Tavern' — OK");
