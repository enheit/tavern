import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const launcherSource = join(here, "..", "build", "tavern-linux-launcher.sh");
const requireFromTest = createRequire(import.meta.url);

interface AfterPackContext {
  appOutDir: string;
  electronPlatformName: string;
  packager: { executableName: string };
}

type AfterPackHook = (context: AfterPackContext) => Promise<void>;

function hasDefaultHook(value: unknown): value is { default: AfterPackHook } {
  if (typeof value !== "object" || value === null || !("default" in value)) return false;
  return typeof value.default === "function";
}

const hookModule: unknown = requireFromTest("../scripts/afterPack.cjs");
if (!hasDefaultHook(hookModule)) throw new Error("afterPack.cjs does not export a default hook");
const installLinuxLauncher = hookModule.default;

const dirs: string[] = [];
const servers: Server[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tavern-linux-launcher-"));
  dirs.push(dir);
  return dir;
}

async function listen(socketPath: string): Promise<void> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
}

async function runLauncher(
  address: string | undefined,
  runtimeDir: string,
): Promise<{ address: string; args: string[] }> {
  const appDir = await tempDir();
  await copyFile(launcherSource, join(appDir, "tavern"));
  await writeFile(
    join(appDir, "tavern-bin"),
    '#!/bin/sh\nprintf "%s\\n" "${DBUS_SESSION_BUS_ADDRESS:-}"\nprintf "<%s>\\n" "$@"\n',
    { mode: 0o755 },
  );
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", XDG_RUNTIME_DIR: runtimeDir };
  if (address !== undefined) env.DBUS_SESSION_BUS_ADDRESS = address;
  const result = await execFileAsync("sh", [join(appDir, "tavern"), "one", "two words"], { env });
  const [resolvedAddress = "", ...argLines] = result.stdout.trimEnd().split("\n");
  return { address: resolvedAddress, args: argLines.map((line) => line.slice(1, -1)) };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        }),
    ),
  );
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Linux packaged launcher", () => {
  it("replaces a stale path address with the live per-user runtime bus before Electron starts", async () => {
    const runtimeDir = await tempDir();
    const runtimeBus = join(runtimeDir, "bus");
    await listen(runtimeBus);

    const result = await runLauncher("unix:path=/tmp/dbus-deleted", runtimeDir);

    expect(result).toEqual({ address: `unix:path=${runtimeBus}`, args: ["one", "two words"] });
  });

  it("uses the runtime bus when the inherited session-bus address is missing", async () => {
    const runtimeDir = await tempDir();
    const runtimeBus = join(runtimeDir, "bus");
    await listen(runtimeBus);

    const result = await runLauncher(undefined, runtimeDir);

    expect(result.address).toBe(`unix:path=${runtimeBus}`);
  });

  it("replaces the invalid disabled sentinel with the live runtime bus", async () => {
    const runtimeDir = await tempDir();
    const runtimeBus = join(runtimeDir, "bus");
    await listen(runtimeBus);

    const result = await runLauncher("disabled:", runtimeDir);

    expect(result).toEqual({ address: `unix:path=${runtimeBus}`, args: ["one", "two words"] });
  });

  it("clears the invalid disabled sentinel when no replacement bus exists", async () => {
    const runtimeDir = await tempDir();

    const result = await runLauncher("disabled:", runtimeDir);

    expect(result.address).toBe("");
  });

  it("preserves a live custom session bus instead of forcing the runtime bus", async () => {
    const runtimeDir = await tempDir();
    const runtimeBus = join(runtimeDir, "bus");
    const customDir = await tempDir();
    const customBus = join(customDir, "dbus-custom");
    await listen(runtimeBus);
    await listen(customBus);

    const result = await runLauncher(`unix:path=${customBus}`, runtimeDir);

    expect(result.address).toBe(`unix:path=${customBus}`);
  });

  it("preserves an unrecognized transport but clears a stale address with no replacement bus", async () => {
    const runtimeDir = await tempDir();
    const tcp = await runLauncher("tcp:host=127.0.0.1,port=1234", runtimeDir);
    const stale = await runLauncher("unix:path=/tmp/dbus-deleted", runtimeDir);

    expect(tcp.address).toBe("tcp:host=127.0.0.1,port=1234");
    expect(stale.address).toBe("");
  });

  it("the afterPack hook wraps only Linux and leaves the original Electron binary executable", async () => {
    const linuxOut = await tempDir();
    const binary = join(linuxOut, "tavern");
    await writeFile(binary, "electron-binary", { mode: 0o755 });

    await installLinuxLauncher({
      appOutDir: linuxOut,
      electronPlatformName: "linux",
      packager: { executableName: "tavern" },
    });

    expect(await readFile(join(linuxOut, "tavern-bin"), "utf8")).toBe("electron-binary");
    expect(await readFile(binary, "utf8")).toBe(await readFile(launcherSource, "utf8"));
    expect((await stat(binary)).mode & 0o111).not.toBe(0);

    const darwinOut = await tempDir();
    const darwinBinary = join(darwinOut, "Tavern");
    await writeFile(darwinBinary, "mac-binary", { mode: 0o755 });
    await installLinuxLauncher({
      appOutDir: darwinOut,
      electronPlatformName: "darwin",
      packager: { executableName: "Tavern" },
    });
    expect(await readFile(darwinBinary, "utf8")).toBe("mac-binary");
  });
});
