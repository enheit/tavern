import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  mediaCategoryForKey,
  readMediaUsage,
  reconcileMediaInventory,
} from "../src/lib/mediaUsageInventory";

describe("media usage inventory", () => {
  it("categorizes Tavern media paths without exposing object keys", () => {
    expect(mediaCategoryForKey("avatars/alice.webp")).toBe("avatars");
    expect(mediaCategoryForKey("sounds/server/clip.webm")).toBe("soundboardAudio");
    expect(mediaCategoryForKey("recordings/server/session.webm")).toBe("recordings");
    expect(mediaCategoryForKey("server/screenshots/capture.webp")).toBe("screenshots");
    expect(mediaCategoryForKey("server/chat-images/paste.webp")).toBe("chatImages");
    expect(mediaCategoryForKey("untracked/file.bin")).toBe("other");
  });

  it("reconciles exact R2 bytes and removes objects deleted from R2", async () => {
    await env.MEDIA.put("avatars/alice.webp", new Uint8Array(2_000));
    await env.MEDIA.put("server-a/screenshots/one.webp", new Uint8Array(3_000_000));
    await env.MEDIA.put("server-a/chat-images/paste.webp", new Uint8Array(5));

    await reconcileMediaInventory(env.DB, env.MEDIA);
    const beforeDelete = await readMediaUsage(env.DB);
    expect(beforeDelete).toMatchObject({ bytes: 3_002_005, objectCount: 3 });
    expect(beforeDelete.reconciledAt).not.toBeNull();
    expect(beforeDelete.categories).toEqual(
      expect.arrayContaining([
        { category: "avatars", bytes: 2_000, objectCount: 1 },
        { category: "screenshots", bytes: 3_000_000, objectCount: 1 },
        { category: "chatImages", bytes: 5, objectCount: 1 },
      ]),
    );

    await env.MEDIA.delete("server-a/screenshots/one.webp");
    await reconcileMediaInventory(env.DB, env.MEDIA);
    const afterDelete = await readMediaUsage(env.DB);
    expect(afterDelete).toMatchObject({ bytes: 2_005, objectCount: 2 });
    expect(afterDelete.categories).toEqual(
      expect.arrayContaining([{ category: "screenshots", bytes: 0, objectCount: 0 }]),
    );
  });
});
