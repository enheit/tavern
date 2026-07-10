import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("S1.1 worker bootstrap", () => {
  it("GET /api/health returns 200 {ok:true}", async () => {
    const res = await SELF.fetch("https://tavern.test/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('unknown /api route returns 404 with {error:"not_found"}', async () => {
    const res = await SELF.fetch("https://tavern.test/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it('direct ServerRoom fetch returns 501 {error:"not_implemented"}', async () => {
    const stub = env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName("t"));
    const res = await stub.fetch("http://do/");
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: "not_implemented" });
  });
});
