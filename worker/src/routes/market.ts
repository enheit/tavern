import { Hono } from "hono";
import { z } from "zod";
import {
  ApiErrorBody,
  DeleteMarketItemResponse,
  EquippedMarketIconResponse,
  LIMITS,
  MarketItemResponse,
  MarketPage,
  MarketScope,
  PatchMarketItemRequest,
  PurchaseMarketItemRequest,
  PurchaseMarketItemResponse,
  PutEquippedMarketIconRequest,
} from "@tavern/shared";
import type { ErrorCode } from "@tavern/shared";
import { requireAdmin, requireMember, zodJson } from "../middleware";
import type { MemberVars } from "../middleware";
import { MarketImageError, normalizeMarketIcon } from "../lib/marketImage";
import {
  recordMediaObject,
  removeMediaObject,
  trackMediaInventory,
} from "../lib/mediaUsageInventory";

function invariant<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

function statusFor(code: ErrorCode): 400 | 403 | 404 | 409 | 413 | 415 | 429 {
  switch (code) {
    case "payload_too_large":
      return 413;
    case "unsupported_media":
      return 415;
    case "not_admin":
    case "forbidden":
      return 403;
    case "not_found":
      return 404;
    case "rate_limited":
      return 429;
    case "market_sold":
    case "market_item_changed":
    case "market_item_frozen":
    case "market_icon_not_owned":
    case "insufficient_points":
      return 409;
    default:
      return 400;
  }
}

function stub(env: Env, serverId: string): DurableObjectStub {
  return env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName(serverId));
}

function internalHeaders(): Record<string, string> {
  return { "content-type": "application/json", "X-Tavern-Internal": "1" };
}

async function forwardError(
  response: Response,
): Promise<{ code: ErrorCode; status: ReturnType<typeof statusFor> }> {
  const code = ApiErrorBody.parse(await response.json()).error;
  return { code, status: statusFor(code) };
}

const marketUploadFields = z.object({
  name: z.string().trim().min(1).max(LIMITS.marketItemNameMax),
  price: z.coerce.number().int().positive().max(LIMITS.marketPriceMax),
});

export const marketRoute = new Hono<{ Bindings: Env; Variables: MemberVars }>();

marketRoute.get("/:id/market", requireMember, async (c) => {
  const query = z
    .object({ scope: MarketScope.default("shop"), cursor: z.string().min(1).optional() })
    .safeParse({ scope: c.req.query("scope"), cursor: c.req.query("cursor") });
  if (!query.success) return c.json({ error: "bad_request" satisfies ErrorCode }, 400);
  const userId = invariant(c.var.userId, "requireMember guarantees userId");
  const params = new URLSearchParams({ scope: query.data.scope, userId });
  if (query.data.cursor !== undefined) params.set("cursor", query.data.cursor);
  const response = await stub(c.env, c.var.serverId).fetch(
    `https://do.internal/internal/market?${params.toString()}`,
    { headers: { "X-Tavern-Internal": "1" } },
  );
  if (!response.ok) {
    const error = await forwardError(response);
    return c.json({ error: error.code }, error.status);
  }
  return c.json(MarketPage.parse(await response.json()));
});

marketRoute.post("/:id/market", requireMember, requireAdmin, async (c) => {
  const declared = c.req.header("content-length");
  if (
    declared !== undefined &&
    Number(declared) > LIMITS.marketIconInputMaxBytes + LIMITS.marketIconMultipartOverheadBytes
  ) {
    return c.json({ error: "payload_too_large" satisfies ErrorCode }, 413);
  }
  const form = await c.req.formData();
  const fields = marketUploadFields.safeParse({ name: form.get("name"), price: form.get("price") });
  const file = form.get("file");
  if (!fields.success || !(file instanceof File)) {
    return c.json({ error: "bad_request" satisfies ErrorCode }, 400);
  }

  let bytes: Uint8Array;
  try {
    bytes = await normalizeMarketIcon(c.env.IMAGES, file);
  } catch (error: unknown) {
    if (error instanceof MarketImageError) {
      return c.json({ error: error.code }, statusFor(error.code));
    }
    throw error;
  }

  const serverId = c.var.serverId;
  const userId = invariant(c.var.userId, "requireAdmin guarantees userId");
  const itemId = crypto.randomUUID();
  const r2Key = `market-icons/${serverId}/${itemId}.webp`;
  const object = await c.env.MEDIA.put(r2Key, bytes, {
    httpMetadata: { contentType: "image/webp" },
  });
  c.executionCtx.waitUntil(trackMediaInventory(recordMediaObject(c.env.DB, object), "put", r2Key));

  const response = await stub(c.env, serverId).fetch("https://do.internal/internal/market/create", {
    method: "POST",
    headers: internalHeaders(),
    body: JSON.stringify({
      itemId,
      name: fields.data.name,
      price: fields.data.price,
      userId,
      isAdmin: true,
      r2Key,
    }),
  });
  if (!response.ok) {
    await c.env.MEDIA.delete(r2Key);
    c.executionCtx.waitUntil(
      trackMediaInventory(removeMediaObject(c.env.DB, r2Key), "delete", r2Key),
    );
    const error = await forwardError(response);
    return c.json({ error: error.code }, error.status);
  }
  return c.json(MarketItemResponse.parse(await response.json()), 201);
});

marketRoute.patch(
  "/:id/market/:itemId",
  requireMember,
  requireAdmin,
  zodJson(PatchMarketItemRequest),
  async (c) => {
    const patch = PatchMarketItemRequest.parse(await c.req.json());
    const response = await stub(c.env, c.var.serverId).fetch(
      "https://do.internal/internal/market/patch",
      {
        method: "POST",
        headers: internalHeaders(),
        body: JSON.stringify({ itemId: c.req.param("itemId"), patch, isAdmin: true }),
      },
    );
    if (!response.ok) {
      const error = await forwardError(response);
      return c.json({ error: error.code }, error.status);
    }
    return c.json(MarketItemResponse.parse(await response.json()));
  },
);

marketRoute.delete("/:id/market/:itemId", requireMember, requireAdmin, async (c) => {
  const response = await stub(c.env, c.var.serverId).fetch(
    "https://do.internal/internal/market/delete",
    {
      method: "POST",
      headers: internalHeaders(),
      body: JSON.stringify({ itemId: c.req.param("itemId"), isAdmin: true }),
    },
  );
  if (!response.ok) {
    const error = await forwardError(response);
    return c.json({ error: error.code }, error.status);
  }
  return c.json(DeleteMarketItemResponse.parse(await response.json()));
});

marketRoute.post(
  "/:id/market/:itemId/purchase",
  requireMember,
  zodJson(PurchaseMarketItemRequest),
  async (c) => {
    const userId = invariant(c.var.userId, "requireMember guarantees userId");
    const profile = await c.env.DB.prepare("SELECT display_name FROM user WHERE id = ?")
      .bind(userId)
      .first<{ display_name: string }>();
    if (profile === null) return c.json({ error: "unauthorized" satisfies ErrorCode }, 401);
    const purchase = PurchaseMarketItemRequest.parse(await c.req.json());
    const response = await stub(c.env, c.var.serverId).fetch(
      "https://do.internal/internal/market/purchase",
      {
        method: "POST",
        headers: internalHeaders(),
        body: JSON.stringify({
          itemId: c.req.param("itemId"),
          userId,
          displayName: profile.display_name,
          purchase,
        }),
      },
    );
    if (!response.ok) {
      const error = await forwardError(response);
      return c.json({ error: error.code }, error.status);
    }
    return c.json(PurchaseMarketItemResponse.parse(await response.json()));
  },
);

marketRoute.put(
  "/:id/market/equipped-icon",
  requireMember,
  zodJson(PutEquippedMarketIconRequest),
  async (c) => {
    const userId = invariant(c.var.userId, "requireMember guarantees userId");
    const body = PutEquippedMarketIconRequest.parse(await c.req.json());
    const response = await stub(c.env, c.var.serverId).fetch(
      "https://do.internal/internal/market/equip",
      {
        method: "PUT",
        headers: internalHeaders(),
        body: JSON.stringify({ userId, itemId: body.itemId }),
      },
    );
    if (!response.ok) {
      const error = await forwardError(response);
      return c.json({ error: error.code }, error.status);
    }
    return c.json(EquippedMarketIconResponse.parse(await response.json()));
  },
);
