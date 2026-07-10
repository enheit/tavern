import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  contentTypeFor,
  registerAppProtocolHandler,
  registerAppScheme,
  rendererRoot,
  resolveAssetPath,
  serveAppRequest,
} from "../src/main/protocol";
import { resetElectronMock, state } from "./electron-mock";

vi.mock("electron", () => import("./electron-mock"));

let dir: string;

describe("app:// protocol handler", () => {
  beforeEach(() => {
    resetElectronMock();
    dir = mkdtempSync(join(tmpdir(), "tavern-proto-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("maps extensions to content types, defaulting to octet-stream", () => {
    expect(contentTypeFor("/index.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor("/assets/app.js")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeFor("/assets/app.css")).toBe("text/css; charset=utf-8");
    expect(contentTypeFor("/logo.svg")).toBe("image/svg+xml");
    expect(contentTypeFor("/x.unknownext")).toBe("application/octet-stream");
  });

  it("resolves in-root paths and refuses traversal", () => {
    expect(resolveAssetPath(dir, "/index.html")).toBe(join(dir, "index.html"));
    expect(resolveAssetPath(dir, "/assets/app.js")).toBe(join(dir, "assets/app.js"));
    expect(resolveAssetPath(dir, "/../secret")).toBeNull();
    expect(resolveAssetPath(dir, "/../../etc/passwd")).toBeNull();
  });

  it("serves an existing file with the right content-type", async () => {
    writeFileSync(join(dir, "hello.txt"), "shell ok");
    const res = await serveAppRequest(new Request("http://tavern/hello.txt"), dir);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe("shell ok");
  });

  it("serves index.html for the root path", async () => {
    writeFileSync(join(dir, "index.html"), "<title>Tavern</title>");
    const res = await serveAppRequest(new Request("http://tavern/"), dir);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("returns 404 for a missing file", async () => {
    const res = await serveAppRequest(new Request("http://tavern/missing.html"), dir);
    expect(res.status).toBe(404);
  });

  it("returns 403 for an encoded traversal attempt", async () => {
    // %2f keeps the dots inside one URL segment (so new URL() cannot normalize them away);
    // decodeURIComponent in the guard then turns it into ../../secret, which escapes the root.
    const res = await serveAppRequest(new Request("http://tavern/%2e%2e%2f%2e%2e%2fsecret"), dir);
    expect(res.status).toBe(403);
  });

  it("registers the privileged app scheme and a protocol handler", async () => {
    registerAppScheme();
    expect(state.registeredSchemes).toEqual([
      { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
    ]);

    writeFileSync(join(dir, "index.html"), "<title>Tavern</title>");
    state.isPackaged = true;
    state.appPath = dir.replace(/\/renderer$/, "");
    registerAppProtocolHandler();
    const handler = state.protocolHandlers.get("app");
    expect(handler).toBeDefined();
  });

  it("serves from the asar renderer/ dir when packaged, app/dist when unpackaged", () => {
    state.isPackaged = true;
    state.appPath = "/tmp/pkg";
    expect(rendererRoot()).toBe(join("/tmp/pkg", "renderer"));

    state.isPackaged = false;
    expect(rendererRoot().endsWith(join("app", "dist"))).toBe(true);
  });
});
