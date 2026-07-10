# S7.3 — Voice UI (join/leave, devices, volumes, speaking, mute/deafen, timer)

- after: S7.1, S7.2, S5.2, S6.2 · unlocks: S7.4, S8.1, S9.2, S9.3 · FRs: FR-18, FR-19, FR-20, FR-21, FR-22, FR-23, FR-24, FR-26
- references: PLAN §7.1 (session topology), §7.3 (graph), §7.6 (shell slots), App-A (`voice.*` frames), App-B, §9.2/§9.9 (component rules)

## Goal

Wire the S7.2 engine to the UI: users join/leave voice from the Channels panel, control mute/
deafen/devices/noise-suppression, set per-user volume+mute, see speaking rings and the voice
session timer. After this step two real clients can talk (verified end-to-end in S7.4).

## Preconditions (run these; red = STOP)

- `grep -q "^## S7.1" docs/progress.md && grep -q "^## S7.2" docs/progress.md && grep -q "^## S5.2" docs/progress.md && grep -q "^## S6.2" docs/progress.md` → exit 0
- `pnpm -F @tavern/app test && pnpm -F @tavern/worker test` → exit 0.

## Tasks

1. Create `app/src/features/voice/voiceController.ts` — non-React orchestrator owning engine
   instances (one `PublishSession`, one voice `PullSession`, one `AudioGraph`) and writing to
   `stores/media.ts`. Pinned join sequence (order is load-bearing — the DO authorizes rtc ops
   only for in-voice users): ① WS `voice.join` (await `voice.state` ack) ② `graph.init` +
   `graph.resume()` (same user gesture) ③ `getMic` ④ `PublishSession.connect` + `publishMic`
   ⑤ voice `PullSession.connect` + `addRemoteTracks` for every existing `mic:*` in room store.
   Reactions: `stream.added mic:*` → pull + `attachRemoteMic`; `stream.removed`/`member.left` →
   remove + detach; WS reconnect while in voice → full teardown + rejoin (§6.2 snapshot
   semantics). Leave = reverse teardown + WS `voice.leave`.
2. Mute/deafen (FR-26): mute = `setTrackEnabled(mic, false)` + WS `voice.state {muted}` (NEVER
   `replaceTrack(null)` — 30 s SFU GC). Deafen forces mute (undeafen restores the prior mute
   flag) + `graph.setDeafened` + WS flag.
3. Noise-suppression toggle + device switching (FR-21/22): add a **Voice** section to the S6.2
   `SettingsDialog` — this step extends S6.2's pinned Tabs union to `account | app | notifications
   | voice` (S6.2 is now an ancestor; the added tab is the only change to that dialog). Section
   controls: input select, output select (`enumerateDevices` after mic permission; labels require
   it), noise switch. Input/noise change while in voice → `retoggleMic`
   (stop→reacquire→replaceTrack); output change → `graph.setSink`. Persist
   `{ micId?, sinkId?, noiseSuppression }` in the settings store (localStorage key
   `tavern.settings.v1` — the device-prefs record, distinct from the volumes record below).
4. Per-user volume/mute (FR-20): context menu (Base UI ContextMenu via shadcn) on People-panel
   rows: slider **displays 0–200%** (default 100%, step 5%, "Reset" item) → `graph.setUserGain(v/100)`
   (store the resulting **gain float 0..2**, not the percent); "Mute <name>" toggle → adds the
   userId to `VolumesV1.mutedUsers` + muted icon on the row (mute is a set-membership flag, not a
   gain of 0). Persisted via the shared `VolumesV1` schema, localStorage key `settings.volumes.v1`;
   stream volumes keyed `${userId}:${kind}` (stable across restarts — trackNames are not). Applied
   on attach.
5. Speaking indicators (FR-23): `watchSpeaking` on the local mic analyser + each
   `getUserAnalyser`; speaking userIds set in `stores/media.ts`; green ring on member chips
   (People panel + voice channel rows).
6. Voice channel row (FR-18): `features/voice/VoiceChannelRow.tsx` in the Channels panel slot
   (S5.2 shell): channel name, live member chips (avatar+color+speaking ring+mute/deafen
   badges), click = join. In voice on another server → Base UI AlertDialog (i18n'd) confirm →
   leave there, join here (client-enforced single-voice rule; the pin in §1.4).
7. Controls bar (FR-18/24/26): **create** `features/shell/ControlsBar.tsx` (S5.2 rendered only an
   empty named controls placeholder inside AppShell — this step is its first content) and mount it
   in `AppShell.tsx`'s controls slot, replacing that placeholder. Contents: Join/Leave state
   button, Mute, Deafen, timer chip (`TimerChip.tsx`: renders from `voice.state.sessionStartedAt`,
   local 1 s display interval, format `mm:ss` under 1 h else `h:mm:ss`; visible to ALL members
   whenever a session is active). Screen-share/cam/record buttons stay disabled placeholders
   (S8.1/S8.3/S9.3).
8. Files created: `features/shell/ControlsBar.tsx`, `features/voice/{voiceController.ts,
   useVoice.ts, VoiceChannelRow.tsx, VoiceMemberChip.tsx, TimerChip.tsx, VolumeMenu.tsx,
   VoiceSettingsSection.tsx}`; modified: `features/shell/AppShell.tsx` (mount <ControlsBar/> in the
   controls slot), `features/servers/PeoplePanel.tsx`, `features/settings/SettingsDialog.tsx` (add
   the Voice tab), `stores/media.ts`, `stores/settings.ts`, `app/messages/{en,uk}.json`.
9. i18n keys (both locales — every user-visible string this step renders; §9.6 maps the dotted
   names to flat snake_case in `app/messages/{en,uk}.json`):

   | key | en | uk |
   |---|---|---|
   | voice.join | Join voice | Приєднатися |
   | voice.leave | Leave | Вийти |
   | voice.mute | Mute | Вимкнути мікрофон |
   | voice.unmute | Unmute | Увімкнути мікрофон |
   | voice.deafen | Deafen | Вимкнути звук |
   | voice.undeafen | Undeafen | Увімкнути звук |
   | voice.volume | Volume | Гучність |
   | voice.reset | Reset | Скинути |
   | voice.muteUser | Mute {name} | Заглушити {name} |
   | voice.elsewhere.title | Already in voice | Ви вже у голосовому каналі |
   | voice.elsewhere.body | Leave that voice channel and join here? | Вийти з того каналу та приєднатися тут? |
   | voice.elsewhere.confirm | Switch | Перейти |
   | voice.elsewhere.cancel | Cancel | Скасувати |
   | settings.tabs.voice | Voice | Голос |
   | settings.voice.input | Input device | Пристрій вводу |
   | settings.voice.output | Output device | Пристрій виводу |
   | settings.voice.noise | Noise suppression | Придушення шуму |

   (`{name}` is a Paraglide single-brace parameter — `m.voice_mute_user({ name })`. `settings.tabs.voice`
   is the new tab added to S6.2's Tabs union.)

## Pinned interfaces & artifacts

```ts
// features/voice/useVoice.ts — the ONLY seam components use
export function useVoice(serverId: string): {
  status: 'idle' | 'joining' | 'joined' | 'leaving' | 'error';
  inVoiceServerId: string | null;            // across all connected servers
  join(): Promise<void>;                      // throws VoiceElsewhereError{serverId} for the confirm flow
  leave(): Promise<void>;
  muted: boolean; setMuted(m: boolean): void;
  deafened: boolean; setDeafened(d: boolean): void;
};

// stores/media.ts additions (zustand)
type MediaState = {
  voiceStatus: 'idle' | 'joining' | 'joined' | 'leaving' | 'error';
  inVoiceServerId: string | null;
  muted: boolean; deafened: boolean;
  speakingUserIds: ReadonlySet<string>;
  deviceSelection: { micId?: string; sinkId?: string; noiseSuppression: boolean };  // selected prefs
};
```

Naming note (avoid the S4.3 collision): S4.3 already pins `devices` on `stores/media.ts` as the
enumerated device *list* plus `selectedMicId`/`selectedSinkId`/`captureState`. This step adds the
selected-prefs object as `deviceSelection` (above) rather than redefining `devices`;
`selectedMicId`/`selectedSinkId` are subsumed by it, `captureState` is untouched (S8.1 owns it).

`VolumesV1` (from `@tavern/shared`): `{ v: 1, users: Record<string, number>, streams:
Record<string, number>, soundboard: number, mutedUsers: string[] }` — the `users`/`streams`/
`soundboard` numbers are **gain floats 0..2** (1.0 = unity). Sliders DISPLAY 0–200%; the stored
value is always the gain. Per-user mute is membership in `mutedUsers`, not a gain of 0.

## Tests

`app/test/voice/voiceController.test.ts` (fake engine + fake WS; 10 named cases)
- `describe('FR-18 join/leave')`: 'join sends voice.join before any rtc call (order)';
  'join wires mic publish then pulls every existing remote mic'; 'leave tears down sessions,
  graph detaches, sends voice.leave'; 'ws reconnect while joined → teardown + rejoin'.
- `describe('FR-18 single-voice rule')`: 'join while in voice elsewhere throws
  VoiceElsewhereError; confirm path leaves A then joins B'.
- `describe('FR-26')`: 'mute disables track, no replaceTrack(null), sends voice.state';
  'deafen forces mute + graph.setDeafened; undeafen restores prior mute'.
- `describe('FR-22')`: 'noise toggle mid-call → retoggleMic sequence'.
- `describe('FR-21')`: 'sink change → graph.setSink; mic change → retoggleMic'.
- `describe('FR-20')`: 'volume slider at 150% → setUserGain(1.5) and persists gain 1.5 under
  settings.volumes.v1'; 'Mute <name> adds userId to VolumesV1.mutedUsers and persists'.
`app/test/voice/TimerChip.test.tsx`
- `describe('FR-24 timer')`: '65s → 01:05'; '3661s → 1:01:01'; 'hidden when sessionStartedAt null'.
`app/test/voice/VoiceChannelRow.test.tsx` (RTL)
- `describe('FR-23 speaking ring')`: 'chip shows ring when userId in speakingUserIds'.
- `describe('FR-18 row click')`: 'click calls join; joined state shows members'.

## DoD gates (verbatim, from repo root)

- [ ] `pnpm -F @tavern/app test -- --coverage` → exit 0; app lines ≥70%, `app/src/media` still ≥85%.
- [ ] `pnpm exec node scripts/check-i18n-literals.mjs` → exit 0 (new UI strings are keyed, en+uk).
- [ ] `pnpm lint && pnpm typecheck` → exit 0.
- [ ] `grep -rn "RTCPeerConnection\|AudioContext" app/src/features` → empty (engine only via S7.2 APIs).

## STOP conditions (beyond global R1)

- Any needed engine capability missing from S7.2's pinned API → blocker (do not extend the API
  ad hoc).
- Base UI Slider/ContextMenu/AlertDialog unavailable via `shadcn add` → blocker (§3.3 pins them
  as present).

## Docs (consult only these)

- https://ui.shadcn.com/docs/components (Base UI tab: slider, context-menu, alert-dialog, select, switch)
- https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/enumerateDevices
