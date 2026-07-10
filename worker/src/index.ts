import { Hono } from "hono";
import type { ErrorCode } from "@tavern/shared";
import { stripEmail, withAuth } from "./middleware";
import type { AuthVars } from "./middleware";
import { registerRoute } from "./routes/register";
import { meRoute } from "./routes/me";
import { mediaRoute } from "./routes/media";
import { serversRoute } from "./routes/servers";
import { soundsRoute } from "./routes/sounds";
import { recordingsRoute } from "./routes/recordings";
import { wsTicketRoute } from "./routes/wsTicket";
import { rtcRoute } from "./routes/rtc";
import { ServerRoom } from "./do/ServerRoom";

const app = new Hono<{ Bindings: Env; Variables: AuthVars }>();

// Registered first so it skips the auth middleware below (no session lookup on a liveness probe).
app.get("/api/health", (c) => c.json({ ok: true }));

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

// Recordings (S9.3, FR-25): multipart upload open/part/complete/abort + list/delete per-server
// recordings. requireMember is applied inside the router; the DO enforces starter/in-voice authz. Its
// paths (`/:id/recordings…`) do not overlap serversRoute's or soundsRoute's.
app.route("/api/servers", recordingsRoute);

// RTC proxy to the Cloudflare Realtime SFU (S7.1, A3): session/tracks/renegotiate/close + ICE creds.
// Membership + the rtc rate limit are applied inside the router; the DO enforces §8 caps.
app.route("/api/rtc", rtcRoute);

// WS ticket issuance + upgrade forwarding (S3.1, A4). Mounted at /api so it owns both
// POST /api/ws-ticket and GET /api/servers/:id/ws (distinct from serversRoute's paths — no overlap).
app.route("/api", wsTicketRoute);

// Hono's default notFound is plain text; the app-wide envelope is { error: ErrorCode }.
app.notFound((c) => c.json({ error: "not_found" satisfies ErrorCode }, 404));

export default app;
export { ServerRoom };
