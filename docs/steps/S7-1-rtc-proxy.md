# S7.1 — RTC proxy, ICE credentials, cost meter

- after: S3.4 · unlocks: S7.3 · FRs: FR-19 (transport), FR-30 (grant enforcement), §8 G1–G6
- references: PLAN §6.1 (rtc routes), §7.1 (SFU mechanics — verbatim, deviations are R1 stops), §8, App-B (limits), App-D (bitrate table), §3.7 (contingencies), §10 (SFU mock)

## Goal

The Worker becomes the only path to the Cloudflare Realtime SFU: typed HTTP client, `/api/rtc/*`
routes, ICE (STUN+TURN) credential endpoint, and the ServerRoom DO's rtc registry + egress cost
meter enforcing G1 (demand-driven pulls), G4 (share cap), G5 (egress meter + kill switch).

## Preconditions (run these; red = STOP)

- `docs/progress.md` has green entries for S3.4 (and transitively S3.1).
- `pnpm -F @tavern/worker test` → exit 0.
- `pnpm -F @tavern/worker exec wrangler whoami` → account id `fd8a5f7a38f28a2cd11e79e85985c7d4`
  (personal account; anything else = STOP, never the Icelook account).

## Tasks

1. **Provision Realtime credentials** (once, recorded in progress.md):
   - Dashboard: Realtime → SFU → Create App (name `tavern`) → note App ID + App Secret.
   - Dashboard: Realtime → TURN → Create Key (name `tavern`) → note TURN Key ID + API Token.
   - `pnpm -F @tavern/worker exec wrangler secret put REALTIME_APP_ID` (repeat for
     `REALTIME_APP_SECRET`, `TURN_KEY_ID`, `TURN_KEY_API_TOKEN`); add the same four to
     `worker/.dev.vars`; add all four to `secrets.required` in `wrangler.jsonc`; store all four in
     Bitwarden under the `tavern` project folder (R7). Dashboard inaccessible → STOP.
2. Implement `worker/src/rtc/realtime.ts` — typed client per the pinned interface below. Base URL
   `https://rtc.live.cloudflare.com/v1`, header `Authorization: Bearer ${REALTIME_APP_SECRET}`.
   **`renegotiate`, `tracks/update`, `tracks/close` are PUT** (§7.1). No retries in v1 (fail →
   typed error to client). No per-session mutex in the Worker: SDP-op serialization is the
   client engine's job (S7.2 promise chain) — the proxy is stateless; document this in a
   constraint comment.
3. Implement `worker/src/rtc/realtimeMock.ts` + fixtures `worker/test/fixtures/sfu/*.json`
   (shapes below). `createRealtimeClient(env)` returns the mock when `env.TAVERN_SFU_MOCK === '1'`.
4. Implement routes per §6.1 in `worker/src/routes/rtc.ts` (session → membership (D1) → DO
   authorize → SFU → respond). Rate limit: `LIMITS.rateRtcOpsPerMin` (middleware).
5. Extend ServerRoom DO with the rtc registry: internal route `/internal/rtc/authorize`
   (op enum below) living in `worker/src/do/roomState.ts` + new `worker/src/do/costMeter.ts`.
   Ordering pins:
   - `session.new` op: SFU first, then DO registers `{userId, sessionId}` (reject if not in
     voice → orphaned SFU session is harmless, SFU GCs it).
   - `publish`: DO authorize+register FIRST (checks in-voice, G4 cap
     `LIMITS.maxConcurrentScreenShares=4`, §7.1 track-name grammar); then SFU `tracks/new`;
     on SFU failure the route sends a compensating `close` op. Registration success →
     `stream.added` broadcast (mic publishes broadcast too — that is how peers learn to pull).
   - `pull`: DO validates ONLY (no registration): target trackName exists in registry AND
     (target is `mic:*` AND caller in voice) OR (caller holds a watch grant from WS
     `watch.start`). Denied → error code `pull_denied` (G1). Grant carries `preferredRid` for
     metering.
   - `layer`: DO updates the grant's rid (meter switches rate), then SFU `tracks/update` (simulcast
     layer switch, FR-33 — matches PLAN §6.1 and S8.4's `op:'layer'`).
   - `close`: DO unregisters tracks / releases grants + flushes meter, then SFU `tracks/close`
     (with `force: true` when the client is gone — disconnect cleanup path from S3.4 also calls
     this internally).
   - `renegotiate`: membership check only, straight passthrough, no DO call.
6. `costMeter.ts` (DO): open-watch ledger `{viewer, trackName, rid, since}`; on release/rid-switch
   and on the S3.4 60s alarm tick: `bytes += kbpsFor(preset, rid) * 1000 / 8 * dtSeconds`
   (`kbpsFor` imported from `@tavern/shared` presets — same table as the client, App-D; decimal
   units, 1 GB = 10^9 bytes). Persist into `egress_log(month)`. At `LIMITS.egressWarnGB` (700)
   → broadcast `cost.warning` once per month-bucket; at `LIMITS.egressKillGB` (900) → `pull`
   authorize for non-mic tracks returns `cost_cap` (voice always allowed). Env
   `KILL_SWITCH_DISABLED=1` bypasses the kill only (meter still counts).
7. `GET /api/rtc/ice` in `worker/src/routes/rtc.ts`: POST
   `https://rtc.live.cloudflare.com/v1/turn/keys/${TURN_KEY_ID}/credentials/generate-ice-servers`
   body `{"ttl": 3600}`, Bearer `TURN_KEY_API_TOKEN`; prepend
   `{ urls: ['stun:stun.cloudflare.com:3478'] }`; per-user in-memory cache 30 min (isolate-local
   Map is acceptable — misses just re-fetch). Mock mode: STUN entry only.

## Pinned interfaces & artifacts

Files created: `worker/src/rtc/realtime.ts`, `worker/src/rtc/realtimeMock.ts`,
`worker/src/routes/rtc.ts`, `worker/src/do/costMeter.ts`, `worker/test/rtc-proxy.test.ts`,
`worker/test/cost-meter.test.ts`, `worker/test/ws/rtc.spec.ts`, `worker/test/fixtures/sfu/*.json`.
Modified: `worker/src/do/roomState.ts`, `worker/src/do/ServerRoom.ts` (route registration),
`worker/wrangler.jsonc` (secrets.required), `worker/.dev.vars`.

```ts
// worker/src/rtc/realtime.ts
export type SessionDescription = { sdp: string; type: 'offer' | 'answer' };
export type LocalTrackReq = { location: 'local'; mid: string; trackName: string };
export type RemoteTrackReq = {
  location: 'remote'; sessionId: string; trackName: string;
  simulcast?: { preferredRid: 'h' | 'l' };
};
export type TrackResult = { trackName?: string; mid?: string; sessionId?: string;
  errorCode?: string; errorDescription?: string };
export type TracksNewResponse = {
  requiresImmediateRenegotiation: boolean;
  tracks: TrackResult[];
  sessionDescription?: SessionDescription;
};
export interface RealtimeClient {
  newSession(): Promise<{ sessionId: string }>;
  newLocalTracks(sessionId: string, offer: SessionDescription, tracks: LocalTrackReq[]): Promise<TracksNewResponse>;
  newRemoteTracks(sessionId: string, tracks: RemoteTrackReq[]): Promise<TracksNewResponse>;
  renegotiate(sessionId: string, answer: SessionDescription): Promise<void>;               // PUT
  updateTrack(sessionId: string, mid: string, simulcast: { preferredRid: 'h' | 'l' }): Promise<void>; // PUT tracks/update
  closeTracks(sessionId: string, mids: string[], offer?: SessionDescription, force?: boolean): Promise<TracksNewResponse>; // PUT tracks/close
}
export function createRealtimeClient(env: { REALTIME_APP_ID: string; REALTIME_APP_SECRET: string; TAVERN_SFU_MOCK?: string }): RealtimeClient;
```

DO authorize op contract (internal fetch, zod-validated):

```ts
type RtcAuthorizeReq =
  | { op: 'session.new'; userId: string; sessionId: string }
  | { op: 'publish'; userId: string; sessionId: string;
      tracks: Array<{ trackName: string; kind: 'mic' | 'screen' | 'screenAudio' | 'cam'; preset?: PresetId }> }
  | { op: 'pull'; userId: string; tracks: Array<{ trackName: string; preferredRid?: 'h' | 'l' }> }
  | { op: 'layer'; userId: string; trackName: string; preferredRid: 'h' | 'l' }
  | { op: 'close'; userId: string; trackNames: string[] };
type RtcAuthorizeRes = { ok: true; publisherSessions?: Record<string, string> } | { ok: false; error: ErrorCode };
```

(`pull` response includes `publisherSessions` mapping trackName → publisher sessionId so the
route can build the SFU `RemoteTrackReq`s — the client never learns other users' sessionIds
beyond what the SFU response echoes.)

Error codes used (must already exist in `shared/src/errors.ts`): `not_in_voice`, `pull_denied`,
`share_cap`, `cost_cap`, `rtc_rate_limited`, `forbidden`.

Mock fixtures (deterministic; keys are the contract). The fixture JSON files hold ONLY static
template bodies; all dynamic behavior (the per-test-run `sessionId` counter, echoing request
mids/tracks back into the response) lives in `realtimeMock.ts`, which reads the template and
fills the dynamic fields:
- `session-new.json` → `{ "sessionId": "mock-sess-0" }` (template; `realtimeMock.ts` substitutes an incrementing `<n>` per session)
- `tracks-new-local.json` → `{ requiresImmediateRenegotiation: false, tracks: [], sessionDescription: { type: "answer", sdp: <static valid SDP answer> } }` (`realtimeMock.ts` echoes the request mids into `tracks`)
- `tracks-new-remote.json` → `{ requiresImmediateRenegotiation: true, tracks: [], sessionDescription: { type: "offer", sdp: <static valid SDP offer with 1 audio + 1 video m-section> } }` (`realtimeMock.ts` echoes the requested trackNames)
- `tracks-update.json`, `tracks-close.json`, `renegotiate` → `{}` (static; `realtimeMock.ts` returns it verbatim for those PUT ops).

Flow (documented verbatim at the top of `routes/rtc.ts`):
`client → Worker (session + D1 membership + rate limit) → DO /internal/rtc/authorize → SFU HTTP → client`.

## Tests

DO WebSocket *delivery* is only observable in the WS project (default-project per-file isolated
storage cannot drive DO WebSockets — S3.1's known-issue pin); so broadcast-observing assertions
live in `rtc.spec.ts` (WS project) and everything else in the default-project files below.

`worker/test/rtc-proxy.test.ts` (pool-workers, `TAVERN_SFU_MOCK=1`):
- `describe('FR-19 rtc proxy auth')`: non-member → 403 `forbidden`; member not in voice →
  `not_in_voice`; in voice → session.new returns sessionId.
- `describe('FR-19 publish registry')`: publish `mic:{uid}` → registry contains it (inspected via
  `runInDurableObject`); bad track name grammar → 400; 5th concurrent `screen:*` publish →
  `share_cap` (G4). (The `stream.added` broadcast is asserted in `rtc.spec.ts`.)
- `describe('FR-30 pull grants')`: pull of `screen:*` without `watch.start` → `pull_denied`;
  after a grant (seeded via `runInDurableObject`) → ok + `publisherSessions` present; mic pull
  needs no grant.
- `describe('FR-19 sdp ops')`: renegotiate + tracks/update pass through (mock called with PUT
  payloads asserted).
`worker/test/cost-meter.test.ts`:
- `describe('§8 G5 cost meter')`:
  - 'h-layer 1080p30 watched 600s = 150,000,000 bytes' (2000 kbps × 1000/8 × 600).
  - 'l-layer watched 3600s = 112,500,000 bytes' (250 kbps × 1000/8 × 3600).
  - 'rid switch mid-watch splits accounting at switch time'.
  - 'crossing 700 GB flags cost.warning once per month-bucket (meter-state idempotency, no WS)';
    'kill at 900 GB → pull returns cost_cap, mic pull still allowed';
    'KILL_SWITCH_DISABLED=1 bypasses kill, meter still increments'.
  - 'alarm tick flushes open watches' (via `runDurableObjectAlarm`).
`worker/test/ws/rtc.spec.ts` (WS project, `TAVERN_SFU_MOCK=1`) — broadcast delivery needing a
live WS peer:
- `describe('FR-19 publish broadcast')`: a connected member publishes `mic:{uid}` → a second
  member's socket receives `stream.added`.
- `describe('§8 G5 cost.warning delivery')`: drive the meter past 700 GB → a connected member's
  socket receives `cost.warning` exactly once.

## DoD gates (verbatim, from repo root)

- [ ] `pnpm -F @tavern/worker test` → exit 0, all suites green (default project; lines ≥80%, the `test` script runs `--coverage`).
- [ ] `pnpm -F @tavern/worker test:ws` → exit 0, 0 failed (WS-delivery specs; excluded from the coverage gate).
- [ ] `pnpm -F @tavern/worker exec wrangler deploy --dry-run` → exit 0 (secrets.required satisfied
      locally via .dev.vars).
- [ ] `! grep -rn "REALTIME_APP_SECRET" app/ desktop/ shared/` → exit 0 (secret never leaves worker).
- [ ] `pnpm lint && pnpm typecheck` → exit 0.
- [ ] progress.md entry includes the Bitwarden item names for the four secrets.

## STOP conditions (beyond global R1)

- SFU response shape differs from the pinned fixtures against the live API (nightly/manual
  check) → blocker citing §7.1.
- Realtime dashboard/App creation unavailable on the personal account → blocker.
- TURN credential endpoint returns a shape other than a ready-to-use `iceServers` array → blocker.

## Docs (consult only these)

- https://developers.cloudflare.com/realtime/sfu/https-api/
- https://developers.cloudflare.com/realtime/static/realtime-api-2024-05-21.yaml
- https://developers.cloudflare.com/realtime/sfu/simulcast/
- https://developers.cloudflare.com/realtime/sfu/limits/
- https://developers.cloudflare.com/realtime/turn/generate-credentials/
- https://developers.cloudflare.com/workers/testing/vitest-integration/get-started/write-your-first-test/
