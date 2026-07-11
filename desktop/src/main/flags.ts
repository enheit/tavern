import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

// Two GPU child-process crashes inside this window trigger a disable-gpu relaunch (software
// rendering fallback). §4 / S4.1.
const GPU_CRASH_WINDOW_MS = 10_000;
const GPU_CRASH_THRESHOLD = 2;

function gpuCrashFlagPath(): string {
  return join(app.getPath("userData"), "gpu-crash");
}

// Applied BEFORE app.whenReady — command-line switches only take effect pre-ready.
export function applyFlags(): void {
  const userData = process.env.TAVERN_USER_DATA;
  if (userData !== undefined && userData.length > 0) {
    app.setPath("userData", userData);
  }

  if (process.env.TAVERN_E2E === "1") {
    // Fake-media flags must be applied here, not via Playwright launch args (playwright#16621, §10).
    app.commandLine.appendSwitch("use-fake-device-for-media-stream");
    app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
    const fakeAudio = process.env.TAVERN_FAKE_AUDIO;
    if (fakeAudio !== undefined && fakeAudio.length > 0) {
      app.commandLine.appendSwitch("use-file-for-fake-audio-capture", fakeAudio);
    }
    if (process.platform === "linux") {
      // Headless Linux CI has no keyring (gnome-keyring/kwallet), so safeStorage.encryptString
      // throws "Encryption is not available." and every secrets:setToken IPC dies. The switch is
      // ignored when passed as a Playwright launch arg (same #16621 class as the fake-media flags —
      // proven by the still-red e2e-desktop after 79d9246), so it must be appended here, pre-ready.
      app.commandLine.appendSwitch("password-store", "basic");
    }
  }

  if (process.platform === "linux") {
    app.commandLine.appendSwitch("enable-features", "PulseaudioLoopbackForScreenShare");
  }

  if (existsSync(gpuCrashFlagPath())) {
    app.commandLine.appendSwitch("disable-gpu");
  }
}

// Runtime guard: repeated GPU-process crashes persist a flag file and relaunch with GPU disabled.
export function registerGpuCrashGuard(): void {
  const crashes: number[] = [];
  app.on("child-process-gone", (_event, details) => {
    if (details.type !== "GPU") return;
    const now = Date.now();
    crashes.push(now);
    const recent = crashes.filter((at) => now - at <= GPU_CRASH_WINDOW_MS);
    if (recent.length >= GPU_CRASH_THRESHOLD) {
      mkdirSync(app.getPath("userData"), { recursive: true });
      writeFileSync(gpuCrashFlagPath(), "1");
      app.relaunch();
      app.exit(0);
    }
  });
}
