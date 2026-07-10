# Blockers

> Append-only. Template: PLAN.md §0.4. A step with an OPEN blocker is frozen until a human
> resolves it. Pre-authorized contingencies (PLAN.md §3.7) are NOT blockers — execute them and
> record in progress.md instead.

## BLOCKER — S7.3 — 2026-07-10
- What the plan says: S7.3's `after:` is `S7.1, S7.2, S5.2, S6.2` (§12 graph: "S7.3 … [after: S7.1, S7.2, S5.2]" plus the step file header adds S6.2). The step file's Preconditions block pins, verbatim, `grep -q "^## S7.1" … && grep -q "^## S6.2" docs/progress.md → exit 0` under the heading "Preconditions (run these; red = STOP)". Task 3: "add a **Voice** section to the S6.2 `SettingsDialog` — this step extends S6.2's pinned Tabs union to `account | app | notifications | voice` (S6.2 is now an ancestor; the added tab is the only change to that dialog)." Task 8's modify-list includes `features/settings/SettingsDialog.tsx (add the Voice tab)`. PLAN §0.5 + R9: a step may start only when all `after:` steps have a green `docs/progress.md` entry; red precondition → STOP.
- What reality says: S6.2 (and S6.1) have NOT landed on branch `step/S7-3`. Observed:
  - Precondition grep exit code: `grep -q "^## S6.2" docs/progress.md` → exit 1 (also S6.1 missing). Full precondition chain → exit 1 (RED).
  - `docs/progress.md` last entry is S5.2; there is no `## S6.1` or `## S6.2` heading.
  - `grep -rln "SettingsDialog" app/` → no matches; `app/src/features/settings/` directory does not exist; `app/src/features/chat/` does not exist.
  - No `settings_tabs_*` i18n keys in `app/messages/en.json`.
  - S5.2's own dependent notes confirm the ownership: "UserMenu (logout only; **S6.2 adds the Settings item**)" and "**S6.1 fills `slot-tabs` … S7.3 fills `slot-controls`**".
  There is therefore no `SettingsDialog`, no pinned `account | app | notifications` Tabs union, and no S6.2 settings-store surface for this step to extend. Fabricating the dialog here would (a) violate R5 (touching/authoring files another step owns) and (b) require reading/deciding S6.2's owned architecture (its Tabs union, account/app/notifications tab contents, and settings-store shape), which §0.1 forbids ("Do not read other step files") and which S7.3 explicitly declares out of scope ("the added tab is the only change to that dialog").
- Attempts (if R6): N/A — this is a red-precondition STOP (R9 / step "red = STOP"), not a 3-strikes gate failure. No code was written; no test was weakened. The rest of S7.3 (voiceController, useVoice, ControlsBar/TimerChip/VoiceChannelRow/VoiceMemberChip/VolumeMenu, PeoplePanel context menu, stores/media.ts, i18n) is buildable, but the step is a single atomic commit whose DoD (`pnpm -F @tavern/app test`, `lint`, `typecheck`, `check-i18n`) cannot pass while task 3/task 8 (the Voice settings tab on the nonexistent SettingsDialog) are unimplementable — a partial S7.3 is not a valid step.
- Smallest question a human must answer: Land S6.1 then S6.2 (which create `features/settings/SettingsDialog.tsx` with its pinned `account | app | notifications` Tabs union and the settings-store surface) and record their green `docs/progress.md` entries, then re-launch S7.3 — or explicitly re-scope S7.3 to define the SettingsDialog itself?
STATUS: OPEN
