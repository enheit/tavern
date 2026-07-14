import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ErrorCode } from "@tavern/shared";
import { stripEmail, withAuth } from "./middleware";
import type { AuthVars } from "./middleware";
import { registerRoute } from "./routes/register";
import { meRoute } from "./routes/me";
import { mediaRoute } from "./routes/media";
import { serversRoute } from "./routes/servers";
import { soundsRoute } from "./routes/sounds";
import { marketRoute } from "./routes/market";
import { recordingsRoute } from "./routes/recordings";
import { screenshotsRoute } from "./routes/screenshots";
import { screenshotViewRoute } from "./routes/screenshotView";
import { chatImagesRoute } from "./routes/chatImages";
import { chatImageViewRoute } from "./routes/chatImageView";
import { wsTicketRoute } from "./routes/wsTicket";
import { rtcRoute } from "./routes/rtc";
import { gifsRoute } from "./routes/gifs";
import { testSeedRoute } from "./routes/testSeed";
import { qoeRoute } from "./routes/qoe";
import { streamPreviewsRoute } from "./routes/streamPreviews";
import { ServerRoom } from "./do/ServerRoom";
import { refreshCloudflareUsage } from "./lib/cloudflareUsage";

const app = new Hono<{ Bindings: Env; Variables: AuthVars }>();

// Registered first so it skips the auth middleware below (no session lookup on a liveness probe).
app.get("/api/health", (c) => c.json({ ok: true }));

// CORS for the packaged desktop renderer (origin app://tavern — PLAN §2 "HTTPS + WSS (same API)"):
// the web client is same-origin (worker-served) and never preflights, but the desktop app fetches
// cross-origin with an Authorization bearer header, so OPTIONS must answer BEFORE withAuth and the
// login response's `set-auth-token` header must be exposed or the renderer can never capture it.
// localhost:5173 covers `pnpm -F @tavern/app dev` hitting a remote worker directly.
app.use(
  "/api/*",
  cors({
    origin: ["app://tavern", "http://localhost:5173"],
    allowHeaders: ["Content-Type", "Authorization"],
    exposeHeaders: ["set-auth-token"],
    credentials: true,
    maxAge: 86_400,
  }),
);

// Build the per-request better-auth instance + resolve the session for every /api route.
app.use("/api/*", withAuth);

// Strip the synthetic email from better-auth's own responses AND from the register wrapper. The
// /api/auth/* glob does NOT match /api/auth-wrap/*, so the wrapper needs its own mount (PLAN §5.1).
app.use("/api/auth/*", stripEmail);
app.use("/api/auth-wrap/*", stripEmail);

// better-auth owns login/logout/session/sign-up under /api/auth/*. In 1.6.23 the handler signature
// is (request: Request) => Promise<Response> — no execution-context parameter to forward
// c.executionCtx into; it is fully awaited, so any background work runs within the live isolate.
app.on(["GET", "POST"], "/api/auth/*", (c) => c.var.auth.handler(c.req.raw));

// FR-01 register wrapper: POST /api/auth-wrap/register (synthesizes the email → signUpEmail).
app.route("/api/auth-wrap", registerRoute);

// Account surface (S1.3): /api/me boot call + profile/avatar/settings, and streamed R2 media reads.
// requireAuth is applied inside each router. /internal/* is NOT routed here — it is DO-stub-only.
app.route("/api/me", meRoute);
app.route("/api/media", mediaRoute);

// Server catalog (S2.1): create / join / list members. requireAuth + requireMember are applied
// inside the router per-route.
app.route("/api/servers", serversRoute);

// Soundboard (S9.1): upload / list / trim / rename / delete per-server sounds. requireMember is
// applied inside the router; the paths (`/:id/sounds…`) do not overlap serversRoute's.
app.route("/api/servers", soundsRoute);

// Per-server, one-of-one market inventory. Listing/purchase/equip are member-scoped; item management
// is admin-only inside the router. Uploaded icons are normalized before reaching R2.
app.route("/api/servers", marketRoute);

// Recordings (S9.3, FR-25): multipart upload open/part/complete/abort + list/delete per-server
// recordings. requireMember is applied inside the router; the DO enforces starter/in-voice authz. Its
// paths (`/:id/recordings…`) do not overlap serversRoute's or soundsRoute's.
app.route("/api/servers", recordingsRoute);

// Screenshots (§ screenshots tab): member-gated list/capture/delete of stream stills. requireMember is
// applied inside the router; its paths (`/:id/screenshots…`) don't overlap the other /api/servers routers.
app.route("/api/servers", screenshotsRoute);

// Authenticated, member-only stream teaser upload/read. The id is an active RTC publication id; the
// room authorizes the publisher before R2 writes and advertises versions through stream.updated.
app.route("/api/servers", streamPreviewsRoute);

// PUBLIC screenshot image bytes (capability URL keyed by two UUIDs) — no auth so the still opens in a
// plain browser tab (web) or the OS browser (Electron). Distinct from /api/servers/:id/screenshots.
app.route("/api/screenshots", screenshotViewRoute);

// Chat image paste (§ chat image paste): member-gated upload of a pasted image to R2. requireMember is
// applied inside the router; its path (`/:id/chat-images`) doesn't overlap the other /api/servers routers.
app.route("/api/servers", chatImagesRoute);

// PUBLIC chat image bytes (capability URL keyed by two UUIDs) — same no-auth new-tab model as the
// screenshot view route. Distinct from /api/servers/:id/chat-images.
app.route("/api/chat-images", chatImageViewRoute);

// RTC proxy to the Cloudflare Realtime SFU (S7.1, A3): session/tracks/renegotiate/close + ICE creds.
// Membership + the rtc rate limit are applied inside the router; the DO enforces §8 caps.
app.route("/api/rtc", rtcRoute);

// Anonymous media QoE batches. Auth is used only for abuse control; the Analytics Engine row has no
// user/server/session/track identifiers by contract.
app.route("/api/qoe", qoeRoute);

// GIF picker search proxy (§ GIF picker): GET /api/gifs/search → Klipy, normalized. requireAuth is
// applied inside the router (search is not server-scoped, so any authed user may query).
app.route("/api/gifs", gifsRoute);

// WS ticket issuance + upgrade forwarding (S3.1, A4). Mounted at /api so it owns both
// POST /api/ws-ticket and GET /api/servers/:id/ws (distinct from serversRoute's paths — no overlap).
app.route("/api", wsTicketRoute);

// Test-only seed routes (S8.5, §10). The env guard lives HERE at router assembly: workerd exposes no
// module-scope env, so the guard is a per-request check on the test flags — in production (neither
// TAVERN_SFU_MOCK nor TAVERN_TEST set) every /api/__test/* path 404s, so the routes are effectively
// excluded from the production surface. TAVERN_SFU_MOCK=1 is the PR/e2e worker env; TAVERN_TEST=1
// additionally covers the nightly real-SFU worker (seed-code needs it there — servers can't be
// created without a one-time code). Routes with a narrower audience re-check their own flag inside
// testSeed.ts (seed-shares → mock only, set-egress/seed-code → TAVERN_TEST).
app.use("/api/__test/*", async (c, next) => {
  if (c.env.TAVERN_SFU_MOCK !== "1" && c.env.TAVERN_TEST !== "1") {
    return c.json({ error: "not_found" satisfies ErrorCode }, 404);
  }
  await next();
});
app.route("/api/__test", testSeedRoute);

// Hono's default notFound is plain text; the app-wide envelope is { error: ErrorCode }.
app.notFound((c) => c.json({ error: "not_found" satisfies ErrorCode }, 404));

export async function scheduled(
  controller: ScheduledController,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  try {
    await refreshCloudflareUsage(env, controller.cron === "17 2 * * *");
  } catch (error: unknown) {
    controller.noRetry();
    console.error("Cloudflare usage scheduled refresh failed", {
      cron: controller.cron,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// Hono is the existing fetch handler. Extend that owned application object with the Worker scheduled
// handler so direct app.fetch tests continue to exercise the exact production request surface.
export default Object.assign(app, { scheduled });
export { ServerRoom };
