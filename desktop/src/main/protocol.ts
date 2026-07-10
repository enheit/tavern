import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { app, protocol } from "electron";

const APP_SCHEME = "app";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

export function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

// Where app:// serves the built renderer from. Packaged: inside the asar at <appPath>/renderer
// (matches S12.1's electron-builder `files` mapping — NOT process.resourcesPath). Unpackaged
// (dev/test): @tavern/app's Vite dist. Never file:// (checklist #18).
export function rendererRoot(): string {
  return app.isPackaged
    ? join(app.getAppPath(), "renderer")
    : join(__dirname, "../../..", "app/dist");
}

// Map an app:// pathname to a real file path, refusing any resolve that escapes the root.
export function resolveAssetPath(root: string, pathname: string): string | null {
  const relative = decodeURIComponent(pathname).replace(/^\/+/, "");
  const rootResolved = resolve(root);
  const target = resolve(rootResolved, normalize(relative));
  if (target !== rootResolved && !target.startsWith(rootResolved + sep)) return null;
  return target;
}

export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

export async function serveAppRequest(
  request: Request,
  root: string = rendererRoot(),
): Promise<Response> {
  const { pathname } = new URL(request.url);
  const wanted = pathname === "/" || pathname === "" ? "/index.html" : pathname;
  const filePath = resolveAssetPath(root, wanted);
  if (filePath === null) return new Response("Forbidden", { status: 403 });
  try {
    const body = await readFile(filePath);
    return new Response(body, { headers: { "content-type": contentTypeFor(filePath) } });
  } catch {
    return new Response("Not Found", { status: 404 });
  }
}

export function registerAppProtocolHandler(): void {
  protocol.handle(APP_SCHEME, (request) => serveAppRequest(request));
}
