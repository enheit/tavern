import { session } from "electron";
import type { Session } from "electron";

// The ONLY permissions ever granted (§7.3). `media` must also be allowed in the CHECK handler or
// navigator.mediaDevices.enumerateDevices() breaks (electron#42713). Everything else is denied.
const ALLOWED_PERMISSIONS = new Set<string>(["media", "speaker-selection"]);

export function isPermissionAllowed(permission: string): boolean {
  return ALLOWED_PERMISSIONS.has(permission);
}

// In TAVERN_E2E mode requests auto-grant on the same allowlist — the request handler already
// resolves programmatically (no prompt), so no separate branch is needed.
export function registerPermissions(target: Session = session.defaultSession): void {
  target.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(isPermissionAllowed(permission));
  });
  target.setPermissionCheckHandler((_webContents, permission) => isPermissionAllowed(permission));
}
