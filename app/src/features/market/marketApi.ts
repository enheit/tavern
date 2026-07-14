import {
  DeleteMarketItemResponse,
  EquippedMarketIconResponse,
  LIMITS,
  MarketItemResponse,
  MarketPage,
  PurchaseMarketItemResponse,
} from "@tavern/shared";
import type { PatchMarketItemRequest } from "@tavern/shared";
import { apiClient } from "@/lib/apiClient";
import { authTransport } from "@/lib/authTransport";

const API_BASE: string = import.meta.env.VITE_API_URL ?? "";

export function marketKey(serverId: string, scope: "shop" | "owned") {
  return ["market", serverId, scope] as const;
}

export function marketIconUrl(serverId: string, itemId: string): string {
  return `${API_BASE}/api/media/market-icons/${serverId}/${itemId}.webp`;
}

// Market media is membership-gated. Packaged desktop sessions authenticate with a bearer header,
// which a plain <img> request cannot attach, so load the bytes through the same authenticated
// transport as the REST client. Rendering the returned Blob preserves animated WebP frames.
export async function fetchMarketIcon(
  serverId: string,
  itemId: string,
  signal: AbortSignal,
): Promise<Blob> {
  const response = await fetch(marketIconUrl(serverId, itemId), {
    headers: await authTransport.getAuthHeaders(),
    credentials: "include",
    signal,
  });
  await authTransport.storeFromResponse(response.headers);
  if (!response.ok) throw new Error(`market icon fetch failed: ${response.status}`);

  const blob = await response.blob();
  if (
    blob.type.toLocaleLowerCase() !== "image/webp" ||
    blob.size === 0 ||
    blob.size > LIMITS.marketIconOutputMaxBytes
  ) {
    throw new Error("market icon response was not a bounded WebP image");
  }
  return blob;
}

export function getMarketPage(serverId: string, scope: "shop" | "owned", cursor?: string) {
  return apiClient.get(
    `/api/servers/${serverId}/market?scope=${scope}${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
    MarketPage,
  );
}

export function purchaseMarketItem(
  serverId: string,
  itemId: string,
  expectedRevision: number,
  wearImmediately: boolean,
) {
  return apiClient.post(
    `/api/servers/${serverId}/market/${itemId}/purchase`,
    PurchaseMarketItemResponse,
    { expectedRevision, wearImmediately },
  );
}

export function equipMarketIcon(serverId: string, itemId: string | null) {
  return apiClient.put(
    `/api/servers/${serverId}/market/equipped-icon`,
    EquippedMarketIconResponse,
    { itemId },
  );
}

export function createMarketItem(
  serverId: string,
  input: { name: string; price: number; file: File },
) {
  const form = new FormData();
  form.set("name", input.name);
  form.set("price", String(input.price));
  form.set("file", input.file);
  return apiClient.upload(`/api/servers/${serverId}/market`, MarketItemResponse, form);
}

export function patchMarketItem(serverId: string, itemId: string, patch: PatchMarketItemRequest) {
  return apiClient.patch(`/api/servers/${serverId}/market/${itemId}`, MarketItemResponse, patch);
}

export function deleteMarketItem(serverId: string, itemId: string) {
  return apiClient.del(`/api/servers/${serverId}/market/${itemId}`, DeleteMarketItemResponse);
}
