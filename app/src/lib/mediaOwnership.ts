export const MEDIA_OWNER_STORAGE_KEY = "tavern.mediaOwner.v1";

function navigationReplacedDocument(): boolean {
  if (typeof performance.getEntriesByType !== "function") return false;
  const entry = performance.getEntriesByType("navigation")[0];
  if (entry === undefined || !("type" in entry)) return false;
  const type = Reflect.get(entry, "type");
  return type === "reload" || type === "back_forward";
}

// This is cleanup intent, not resumable media state. Browser capture tracks cannot survive a full
// document replacement, but sessionStorage does, so the next document can tell the room exactly
// which tab-owned voice lifetime it must end. A separately opened tab gets a `navigate` entry and
// discards any sessionStorage value cloned by the browser instead of touching the original tab.
export function markMediaOwner(serverId: string): void {
  sessionStorage.setItem(MEDIA_OWNER_STORAGE_KEY, serverId);
}

export function clearMediaOwner(serverId: string): void {
  if (sessionStorage.getItem(MEDIA_OWNER_STORAGE_KEY) === serverId) {
    sessionStorage.removeItem(MEDIA_OWNER_STORAGE_KEY);
  }
}

export function shouldResetMediaAfterNavigation(serverId: string): boolean {
  const owner = sessionStorage.getItem(MEDIA_OWNER_STORAGE_KEY);
  if (!navigationReplacedDocument()) {
    if (owner !== null) sessionStorage.removeItem(MEDIA_OWNER_STORAGE_KEY);
    return false;
  }
  return owner === serverId;
}
