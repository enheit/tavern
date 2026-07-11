import { Hono } from "hono";
import { z } from "zod";
import type { GifResult, GifSearchResponse } from "@tavern/shared";
import type { AuthVars } from "../middleware";
import { requireAuth } from "../middleware";

// GIF picker proxy (§ GIF picker). The GIF provider (Klipy) puts the API KEY IN THE URL PATH, so it
// can never touch the client — this Worker route is the only caller. It hits Klipy, then returns the
// shared normalized `GifSearchResponse` so the app stays vendor-agnostic (swapping providers is a
// worker-only change). When `KLIPY_API_KEY` is unset (e.g. the hermetic e2e env) it serves a small
// fixed mock set so the whole picker flow is still exercisable offline.
//
// KLIPY_API_KEY is an OPTIONAL secret (dev/prod via .dev.vars / `wrangler secret put`), not a deployed
// binding, so it is declared here rather than in the generated Env (mirrors rtc.ts's TAVERN_SFU_MOCK).
declare global {
  interface Env {
    KLIPY_API_KEY?: string;
  }
}

const KLIPY_BASE = "https://api.klipy.com/api/v1";
const PER_PAGE = 24;
const QUERY_MAX = 100;
// Tier preference walked when extracting a variant: `hd` is the largest Klipy ships (still modest —
// a few hundred px), used for the inline message; the preview grid wants the lightest that exists.
const FULL_TIERS = ["hd", "md", "sm"] as const;
const PREVIEW_TIERS = ["sm", "xs", "md"] as const;

// Untrusted upstream JSON (§9.8 boundary): validate the envelope + each item defensively. Klipy also
// injects `type:"ad"` items into search/trending results — those lack a real `file.*.gif`, so a strict
// per-item parse plus the `type === "gif"` gate drops them without special-casing.
const KlipyMedia = z.object({
  url: z.string().url(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
const KlipyTier = z.object({ gif: KlipyMedia.optional() });
const KlipyItem = z.object({
  id: z.union([z.number(), z.string()]),
  type: z.string().optional(),
  file: z
    .object({
      hd: KlipyTier.optional(),
      md: KlipyTier.optional(),
      sm: KlipyTier.optional(),
      xs: KlipyTier.optional(),
    })
    .optional(),
});
const KlipyResponse = z.object({
  data: z.object({
    data: z.array(z.unknown()),
    has_next: z.boolean().optional(),
    current_page: z.number().optional(),
  }),
});

type KlipyFile = z.infer<typeof KlipyItem>["file"];

function pickVariant(
  file: KlipyFile,
  tiers: readonly ("hd" | "md" | "sm" | "xs")[],
): z.infer<typeof KlipyMedia> | null {
  if (file === undefined) return null;
  for (const tier of tiers) {
    const gif = file[tier]?.gif;
    if (gif !== undefined) return gif;
  }
  return null;
}

export function normalize(raw: unknown[]): GifResult[] {
  const results: GifResult[] = [];
  for (const entry of raw) {
    const parsed = KlipyItem.safeParse(entry);
    if (!parsed.success) continue;
    const item = parsed.data;
    if (item.type !== undefined && item.type !== "gif") continue; // drop ad / sticker / clip items
    const full = pickVariant(item.file, FULL_TIERS);
    const preview = pickVariant(item.file, PREVIEW_TIERS);
    if (full === null || preview === null) continue;
    results.push({
      id: String(item.id),
      url: full.url,
      previewUrl: preview.url,
      width: full.width,
      height: full.height,
    });
  }
  return results;
}

// A handful of real Klipy CDN GIFs (public URLs, no key needed to display) returned when no API key is
// configured, so the picker renders and the send→display flow is testable without network search.
const MOCK: GifResult[] = [
  {
    id: "mock-1",
    url: "https://static.klipy.com/ii/d70658e4be8be2e3047ca9c4e9597a13/40/3a/7IqYv8jA.gif",
    previewUrl: "https://static.klipy.com/ii/d70658e4be8be2e3047ca9c4e9597a13/40/3a/gNFpIWsm.gif",
    width: 300,
    height: 300,
  },
  {
    id: "mock-2",
    url: "https://static.klipy.com/ii/c3a19a0b747a76e98651f2b9a3cca5ff/eb/34/LBMeDPwR.gif",
    previewUrl: "https://static.klipy.com/ii/c3a19a0b747a76e98651f2b9a3cca5ff/eb/34/YMU2XxIF.gif",
    width: 394,
    height: 228,
  },
  {
    id: "mock-3",
    url: "https://static.klipy.com/ii/39f2394ae36df6e199be9eb7c9fa1012/fe/d8/5MVSY6G9.gif",
    previewUrl: "https://static.klipy.com/ii/39f2394ae36df6e199be9eb7c9fa1012/fe/d8/XN2xEdJq.gif",
    width: 498,
    height: 426,
  },
  {
    id: "mock-4",
    url: "https://static.klipy.com/ii/e293a233a303a98e471f78d04e13a1b0/e3/31/eMNmVCpR.gif",
    previewUrl: "https://static.klipy.com/ii/e293a233a303a98e471f78d04e13a1b0/e3/31/haYxnpBZ.gif",
    width: 498,
    height: 371,
  },
  {
    id: "mock-5",
    url: "https://static.klipy.com/ii/2711dd8a75a85be822d136ec94899b3f/12/48/jW3PUhVC.gif",
    previewUrl: "https://static.klipy.com/ii/2711dd8a75a85be822d136ec94899b3f/12/48/11D8jOJs.gif",
    width: 328,
    height: 188,
  },
  {
    id: "mock-6",
    url: "https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/d9/65/RbKudEuD.gif",
    previewUrl: "https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/d9/65/G2CuWPkv.gif",
    width: 275,
    height: 498,
  },
];

export const gifsRoute = new Hono<{ Bindings: Env; Variables: AuthVars }>();

// GET /api/gifs/search?q=<query>&pos=<opaque cursor>. Empty `q` → provider trending. `pos` is the
// opaque cursor from a prior `next` (Klipy page number); the client never interprets it.
gifsRoute.get("/search", requireAuth, async (c) => {
  const key = c.env.KLIPY_API_KEY;
  const q = (c.req.query("q") ?? "").trim().slice(0, QUERY_MAX);
  const empty: GifSearchResponse = { results: [], next: null };

  if (key === undefined || key === "") {
    return c.json({ results: MOCK, next: null } satisfies GifSearchResponse);
  }

  const page = Math.min(Math.max(1, Number.parseInt(c.req.query("pos") ?? "1", 10) || 1), 100);
  const customerId = c.get("userId") ?? "anon"; // stable per-user id for Klipy personalization
  const params = new URLSearchParams({
    per_page: String(PER_PAGE),
    page: String(page),
    customer_id: customerId,
    content_filter: "medium",
  });
  const section = q.length === 0 ? "trending" : "search";
  if (q.length > 0) params.set("q", q);
  const url = `${KLIPY_BASE}/${key}/gifs/${section}?${params.toString()}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error("klipy upstream not ok", res.status);
      return c.json(empty);
    }
    const parsed = KlipyResponse.safeParse(await res.json());
    if (!parsed.success) {
      console.error("klipy response parse failed");
      return c.json(empty);
    }
    const results = normalize(parsed.data.data.data);
    const hasNext = parsed.data.data.has_next ?? false;
    const current = parsed.data.data.current_page ?? page;
    return c.json({
      results,
      next: hasNext ? String(current + 1) : null,
    } satisfies GifSearchResponse);
  } catch (err) {
    console.error("klipy fetch threw", err);
    return c.json(empty);
  }
});
