import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { TONE_WAV, WEB_URL } from "../playwright.config";
import type { SeededUser } from "./fixtures";

// Electron launch helpers for the desktop e2e project (PLAN §10). The fake-media flags flow through
// the main process (S4.1 `appendSwitch`, gated by TAVERN_E2E=1), NOT through Playwright launch args —
// `launch({ args })` flags are unreliable in Electron (playwright#16621). We only pass the env
// contract S4.1 froze: TAVERN_E2E / TAVERN_USER_DATA / TAVERN_FAKE_AUDIO / TAVERN_RENDERER_URL.

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(here, "..", "..", "desktop");

// electron is @tavern/desktop's dependency, not @tavern/e2e's, so a bare `_electron.launch({ args:
// ['.'] })` cannot resolve the binary from this package — resolve it from the desktop package and
// pass it explicitly. The env contract, `args: ['.']`, and cwd are otherwise exactly as pinned.
const requireFromDesktop = createRequire(path.join(desktopDir, "package.json"));
function electronExecutable(): string {
  const resolved: unknown = requireFromDesktop("electron");
  if (typeof resolved !== "string") {
    throw new Error("launchDesktop: could not resolve the electron executable path");
  }
  return resolved;
}

export interface DesktopInstance {
  app: ElectronApplication;
  page: Page;
}

const launched: ElectronApplication[] = [];
const createdDirs: string[] = [];

export async function launchDesktop(opts: {
  instance: number;
  user?: SeededUser;
}): Promise<DesktopInstance> {
  // Distinct userData per instance so two concurrent instances never share state (the single-instance
  // lock is skipped under TAVERN_E2E — §10). `user` names the dir for debuggability now and is the
  // seam later steps extend to pre-authenticate a launch.
  const userDataDir = mkdtempSync(
    path.join(tmpdir(), `tavern-e2e-${opts.instance}-${opts.user?.username ?? "anon"}-`),
  );
  createdDirs.push(userDataDir);

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.TAVERN_E2E = "1";
  env.TAVERN_USER_DATA = userDataDir;
  env.TAVERN_FAKE_AUDIO = TONE_WAV;
  env.TAVERN_RENDERER_URL = WEB_URL;

  // Packaged-binary mode (S12.1's packaged smoke): launch the built executable directly, same env,
  // no cwd/args. Otherwise run the unpackaged app (`.`) from the desktop package with the resolved
  // electron binary.
  // On Linux CI the unprivileged-userns sandbox is restricted (§11) — pass --no-sandbox to the
  // test electron. It is a standard chromium argv switch (reliable via args, unlike the fake-media
  // flags of #16621, which is why those still go through the main process). Kept off macOS/Windows.
  const sandboxArgs = process.platform === "linux" ? ["--no-sandbox"] : [];
  // Electron 43 (Chromium 150) runs the audio service out-of-process, so the main-process
  // `use-file-for-fake-audio-capture` switch (S4.1/§10) never reaches it and the fake mic emits
  // silence — the tone WAV can't drive the speaking analyser (S7.4). Forcing in-process audio fixes
  // it (verified: fake-tone RMS ≈ 0.145 ≫ the §App-B 0.02 threshold). A plain feature switch, reliable
  // via launch args (unlike the fake-media flags that #16621 requires go through the main process).
  const audioArgs = ["--disable-features=AudioServiceOutOfProcess"];

  const binary = process.env.TAVERN_DESKTOP_BINARY;
  const app =
    binary !== undefined && binary.length > 0
      ? await _electron.launch({
          executablePath: binary,
          args: [...audioArgs, ...sandboxArgs],
          env,
        })
      : await _electron.launch({
          executablePath: electronExecutable(),
          args: [".", ...audioArgs, ...sandboxArgs],
          cwd: desktopDir,
          env,
        });
  launched.push(app);

  const page = await app.firstWindow();
  return { app, page };
}

// Closes every app launched this run and removes its temp userData dir (best effort).
export async function closeAll(): Promise<void> {
  const apps = launched.splice(0);
  await Promise.all(
    apps.map(async (app) => {
      try {
        await app.close();
      } catch {
        // already exited — nothing to close.
      }
    }),
  );
  for (const dir of createdDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort — the OS reaps tmp dirs.
    }
  }
}
