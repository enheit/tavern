import { env, runInDurableObject, SELF } from "cloudflare:test";
import {
  DeleteMarketItemResponse,
  EquippedMarketIconResponse,
  MarketItemResponse,
  MarketPage,
  MeResponse,
  PurchaseMarketItemResponse,
  ServerSummary,
} from "@tavern/shared";
import { describe, expect, it } from "vitest";
import { MarketModule } from "../src/do/market";
import { PointsModule } from "../src/do/points";

const BASE = "https://tavern.test";
type RoomStub = DurableObjectStub<import("../src/do/ServerRoom").ServerRoom>;

function must<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

async function session(username: string): Promise<string> {
  const response = await SELF.fetch(`${BASE}/api/auth-wrap/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "password123", repeatPassword: "password123" }),
  });
  if (!response.ok) throw new Error(`register failed: ${response.status} ${await response.text()}`);
  return must(response.headers.get("set-auth-token"), "registration token");
}

function authed(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return SELF.fetch(`${BASE}${path}`, { ...init, headers });
}

async function createServer(token: string): Promise<ServerSummary> {
  const code = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO server_creation_codes (code, created_at) VALUES (?, ?)")
    .bind(code, Date.now())
    .run();
  const response = await authed(token, "/api/servers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nickname: "marketroute", password: "hunter2", code }),
  });
  expect(response.status).toBe(201);
  return ServerSummary.parse(await response.json());
}

async function userId(token: string): Promise<string> {
  const response = await authed(token, "/api/me");
  expect(response.status).toBe(200);
  return MeResponse.parse(await response.json()).user.userId;
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

describe("server market HTTP routes", () => {
  it("lists, purchases, equips, patches, and deletes market items through authenticated routes", async () => {
    const ownerToken = await session("marketowner");
    const server = await createServer(ownerToken);
    const buyerToken = await session("marketbuyer");
    const join = await authed(
      buyerToken,
      "/api/servers/join",
      jsonRequest("POST", { nickname: server.nickname, password: "hunter2" }),
    );
    expect(join.status).toBe(200);
    const ownerId = await userId(ownerToken);
    const buyerId = await userId(buyerToken);
    const stub: RoomStub = env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName(server.id));
    const [purchasable, editable] = await runInDurableObject(stub, (_instance, state) => {
      const points = new PointsModule(state.storage.sql);
      const market = new MarketModule(state.storage, points);
      points.setBalanceForTest(buyerId, 100, Date.now());
      return [
        market.create({
          id: crypto.randomUUID(),
          name: "Animated fox",
          price: 40,
          createdBy: ownerId,
          r2Key: `market-icons/${server.id}/fox.webp`,
          now: Date.now(),
        }),
        market.create({
          id: crypto.randomUUID(),
          name: "Editable owl",
          price: 25,
          createdBy: ownerId,
          r2Key: `market-icons/${server.id}/owl.webp`,
          now: Date.now(),
        }),
      ];
    });

    const listed = await authed(buyerToken, `/api/servers/${server.id}/market?scope=shop`);
    expect(listed.status).toBe(200);
    expect(MarketPage.parse(await listed.json()).items).toHaveLength(2);

    const invalidScope = await authed(buyerToken, `/api/servers/${server.id}/market?scope=invalid`);
    expect(invalidScope.status).toBe(400);
    expect(await invalidScope.json()).toEqual({ error: "bad_request" });

    const purchase = await authed(
      buyerToken,
      `/api/servers/${server.id}/market/${purchasable.id}/purchase`,
      jsonRequest("POST", {
        expectedRevision: purchasable.revision,
        wearImmediately: true,
      }),
    );
    expect(purchase.status).toBe(200);
    expect(PurchaseMarketItemResponse.parse(await purchase.json())).toMatchObject({
      points: { balance: 60 },
      equippedIcon: { itemId: purchasable.id },
    });

    const unequip = await authed(
      buyerToken,
      `/api/servers/${server.id}/market/equipped-icon`,
      jsonRequest("PUT", { itemId: null }),
    );
    expect(unequip.status).toBe(200);
    expect(EquippedMarketIconResponse.parse(await unequip.json()).icon).toBeNull();

    const patch = await authed(
      ownerToken,
      `/api/servers/${server.id}/market/${editable.id}`,
      jsonRequest("PATCH", { name: "Golden owl", price: 30 }),
    );
    expect(patch.status).toBe(200);
    expect(MarketItemResponse.parse(await patch.json()).item).toMatchObject({
      id: editable.id,
      name: "Golden owl",
      price: 30,
    });

    const remove = await authed(ownerToken, `/api/servers/${server.id}/market/${editable.id}`, {
      method: "DELETE",
    });
    expect(remove.status).toBe(200);
    expect(DeleteMarketItemResponse.parse(await remove.json()).itemId).toBe(editable.id);

    const owned = await authed(buyerToken, `/api/servers/${server.id}/market?scope=owned`);
    expect(owned.status).toBe(200);
    expect(MarketPage.parse(await owned.json()).items.map((item) => item.id)).toEqual([
      purchasable.id,
    ]);
  });
});
