import { randomBytes } from "node:crypto";
import { test as base, expect } from "@playwright/test";
import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { ServerSummary } from "@tavern/shared";
import { WEB_URL } from "../playwright.config";

// Members live on Dashboard while chat remains persistent. Navigate to Dashboard before assertions
// so callers are deterministic even when an earlier step selected another workspace view.
export async function withDashboardMembers<T>(page: Page, fn: () => Promise<T>): Promise<T> {
  await page.getByTestId("workspace-tab-dashboard").click();
  return fn();
}

export async function expectMemberVisible(page: Page, userId: string): Promise<void> {
  await withDashboardMembers(page, () =>
    expect(page.getByTestId(`home-member-${userId}`)).toBeVisible(),
  );
}

export async function expectMemberAbsent(page: Page, userId: string): Promise<void> {
  await withDashboardMembers(page, () =>
    expect(page.getByTestId(`home-member-${userId}`)).toHaveCount(0),
  );
}

// The shell renders before its WebSocket handshake finishes. Commands sent in that short window are
// intentionally dropped, so tests that interact with live room state must gate on both milestones.
export async function expectServerReady(page: Page, timeout = 20_000): Promise<void> {
  await expect(page.getByTestId("app-shell")).toBeVisible({ timeout });
  await expect(page.getByTestId("connection-dot")).toHaveAttribute("data-status", "open", {
    timeout,
  });
}

// The frozen harness surface every later e2e step reuses (PLAN §10). Fixtures `api` and
// `twoContexts` are pinned by name — later steps EXTEND them, never rename. Everything talks to the
// active target (the project `baseURL`): for the `web` project that is the Vite dev server, which
// proxies /api → the worker; S11.1's `web-worker` project points the same fixtures at the worker.

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

// A registered user plus its own authenticated APIRequestContext (cookie jar). Later steps read the
// bearer `token` (desktop uses bearer auth) or transfer `request`'s storageState into a browser
// context (web uses the session cookie).
export interface SeededUser {
  userId: string;
  username: string;
  password: string;
  token: string;
  request: APIRequestContext;
}

export interface Api {
  createUser(prefix: string): Promise<SeededUser>;
  createServer(admin: SeededUser, opts?: { password?: string }): Promise<ServerSummary>;
  join(user: SeededUser, nickname: string, password?: string): Promise<ServerSummary>;
  seedCreationCode(user: SeededUser): Promise<string>;
  seedPoints(user: SeededUser, serverId: string, balance: number): Promise<void>;
}

// Every server now has a password (CreateServerRequest requires one). Fixture-created servers use
// this default unless a spec passes its own, and `join` falls back to the same default — so the
// historical `createServer(a)` + `join(b, nickname)` pairing keeps working unchanged.
export const E2E_SERVER_PASSWORD = "pw-e2e";

// Reads `user.id` out of the register response without an `as`-cast (structural narrowing only).
function readUserId(body: unknown): string {
  if (
    typeof body === "object" &&
    body !== null &&
    "user" in body &&
    typeof body.user === "object" &&
    body.user !== null &&
    "id" in body.user &&
    typeof body.user.id === "string"
  ) {
    return body.user.id;
  }
  throw new Error("createUser: unexpected register response shape");
}

// Mints a fresh one-time server-creation code via the test-only worker route (TAVERN_TEST=1 envs:
// the mock e2e worker AND the nightly real-SFU worker). Every POST /api/servers must spend one.
async function seedCreationCode(user: SeededUser): Promise<string> {
  const res = await user.request.post("/api/__test/seed-code");
  if (!res.ok()) {
    throw new Error(`seedCreationCode failed: ${res.status()} ${await res.text()}`);
  }
  const body: unknown = await res.json();
  if (
    typeof body === "object" &&
    body !== null &&
    "code" in body &&
    typeof body.code === "string"
  ) {
    return body.code;
  }
  throw new Error("seedCreationCode: unexpected response shape");
}

async function seedPoints(user: SeededUser, serverId: string, balance: number): Promise<void> {
  const res = await user.request.post("/api/__test/seed-points", {
    data: { serverId, userId: user.userId, balance },
  });
  if (!res.ok()) {
    throw new Error(`seedPoints failed: ${res.status()} ${await res.text()}`);
  }
}

async function createServer(
  admin: SeededUser,
  opts?: { password?: string },
): Promise<ServerSummary> {
  const nickname = `e2e-${hex(4)}`;
  const data = {
    nickname,
    password: opts?.password ?? E2E_SERVER_PASSWORD,
    code: await seedCreationCode(admin),
  };
  const res = await admin.request.post("/api/servers", { data });
  if (!res.ok()) {
    throw new Error(`createServer failed: ${res.status()} ${await res.text()}`);
  }
  return ServerSummary.parse(await res.json());
}

async function joinServer(
  user: SeededUser,
  nickname: string,
  password?: string,
): Promise<ServerSummary> {
  const data = { nickname, password: password ?? E2E_SERVER_PASSWORD };
  const res = await user.request.post("/api/servers/join", { data });
  if (!res.ok()) {
    throw new Error(`join failed: ${res.status()} ${await res.text()}`);
  }
  return ServerSummary.parse(await res.json());
}

export interface TwoClient {
  user: SeededUser;
  context: BrowserContext;
  page: Page;
}

export interface TwoContexts {
  server: ServerSummary;
  admin: SeededUser;
  clients: [TwoClient, TwoClient];
}

interface HarnessFixtures {
  api: Api;
  twoContexts: TwoContexts;
}

export const test = base.extend<HarnessFixtures>({
  api: async ({ playwright, baseURL }, use) => {
    const track: APIRequestContext[] = [];
    const target = baseURL ?? WEB_URL;

    const createUser = async (prefix: string): Promise<SeededUser> => {
      const username = `u_${prefix}_${hex(3)}`;
      const password = `pw-${hex(4)}`;
      const ctx = await playwright.request.newContext({ baseURL: target });
      track.push(ctx);
      const res = await ctx.post("/api/auth-wrap/register", {
        data: { username, password, repeatPassword: password },
      });
      if (!res.ok()) {
        throw new Error(`createUser register failed: ${res.status()} ${await res.text()}`);
      }
      const token = res.headers()["set-auth-token"];
      if (typeof token !== "string" || token.length === 0) {
        throw new Error("createUser: missing set-auth-token header");
      }
      const body: unknown = await res.json();
      return { userId: readUserId(body), username, password, token, request: ctx };
    };

    await use({ createUser, createServer, join: joinServer, seedCreationCode, seedPoints });
    await Promise.all(track.map((ctx) => ctx.dispose()));
  },

  twoContexts: async ({ browser, api, baseURL }, use) => {
    const target = baseURL ?? WEB_URL;
    const admin = await api.createUser("admin");
    const server = await api.createServer(admin);

    // The two users are independent, so build both contexts in parallel.
    const built = await Promise.all(
      (["a", "b"] as const).map(async (prefix): Promise<TwoClient> => {
        const user = await api.createUser(prefix);
        await api.join(user, server.nickname);
        const context = await browser.newContext({
          baseURL: target,
          storageState: await user.request.storageState(),
        });
        const page = await context.newPage();
        await page.goto(`/s/${server.id}`);
        return { user, context, page };
      }),
    );

    const [first, second] = built;
    if (first === undefined || second === undefined) {
      throw new Error("twoContexts: expected exactly two clients");
    }
    await use({ server, admin, clients: [first, second] });
    await Promise.all(built.map((client) => client.context.close()));
  },
});

export { expect } from "@playwright/test";
