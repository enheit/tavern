# Tavern — Progress log

Append one line per completed step, per the PLAN.md Progress protocol:

`## S<id> — <date> — DONE | tests: <n> passed | measurements: {…} | commit <sha> | deviations: none|<listed>`

---

## Pinned toolchain & dependency versions (recorded at S0.1)

| Thing | Version | Where pinned |
|---|---|---|
| Node (project) | 22 (`>=22` engines); local dev machine runs 24.13.1 | `.nvmrc`, `package.json` engines |
| pnpm | 9.15.9 | root `package.json` `packageManager` |
| Rust (stable) | 1.93.1 | `rust-toolchain.toml` |
| svelte | 5.56.4 | `app/package.json` |
| vite | 8.1.3 | `app/package.json` |
| @sveltejs/vite-plugin-svelte | 7.2.0 | `app/package.json` |
| typescript | 6.0.3 | `app/` + `worker/package.json` |
| svelte-check | 4.7.2 | `app/package.json` |
| hono | 4.12.28 | `worker/package.json` |
| wrangler | 4.108.0 | `worker/package.json` |
| @cloudflare/workers-types | 5.20260708.1 | `worker/package.json` |

Notes:
- Plan §1 pins "latest pnpm 9.x" and "Node 22 LTS". Local machine has pnpm 10.33.0 and
  Node 24.13.1; `packageManager: pnpm@9.15.9` forces pnpm 9 via corepack self-management,
  and `.nvmrc`/engines/CI declare Node 22 (local Node 24 satisfies `>=22`). Not a deviation.

---

## S0.1 — 2026-07-08 — DONE | tests: 3 passed | measurements: {pnpm_install: ok (pnpm 9.15.9), pnpm_-r_build: exit 0 (app vite bundle 25.26 KiB gzip 10.10 KiB; worker wrangler dry-run 63.62 KiB gzip 15.42 KiB), cargo_test_workspace: 3 passed (protocol/engine/capture), cargo_clippy: exit 0 no warnings, cargo_fmt_check: exit 0, dev_worker_curl: "GET / 200 OK" → body "ok", secret_scan: empty} | commit 9f81e0b | deviations: none
CI (push, run 28920444082): web-test ✓, rust-test ✓ ×3 (ubuntu/windows/macos incl. llvm-cov), bundle ✗ ×3 (expected — no Tauri until S0.2, per plan).

## S0.2 — 2026-07-08 — DONE | tests: cargo(4 workspace, incl tavern-desktop compile) + lint green | measurements: {tauri_build: exit 0 → Tavern.app 7.8M (target/release/bundle/macos/Tavern.app) + Tavern_0.1.0_aarch64.dmg 2.6M (target/release/bundle/dmg/), release_bin: 8.2M; tauri_dev: launched — vite :1420 HTTP 200, cargo Finished, "Running target/debug/tavern-desktop", window PID live, screenshot docs/qa/s0.2.png (native window, 2400×1520 retina, title bar "Tavern", light theme, page rendered); cargo_fmt/clippy/test_workspace: exit 0 (incl src-tauri); pnpm_-r_lint/build: exit 0; identifier app.tavern.desktop, window 1200×760 min 940×560, devUrl :1420, frontendDist ../app/dist; native screencapture required macOS Screen Recording + Accessibility grants (granted this session)} | commit e0ce45a | deviations: none
CI (run 28921479675, sha e1c870a): bundle ✓ ×3 (ubuntu/windows/macos) — **S0.2 DoD met**; web-test ✓; rust-test ✓ macos/windows. rust-test ubuntu FAILED on the coverage gate: adding the src-tauri shell (0%-covered GUI boilerplate) dropped workspace lines to 62.50%, tripping `--fail-under-lines 70` — but PLAN says coverage enforcement flips on at S2.1. Fixed in follow-up commit 93a771c (llvm-cov → measure-only until S2.1); re-verified all green: run 28921911127 (sha 93a771c) — web-test ✓, rust-test ✓ ×3, bundle ✓ ×3.

## S0.3 — 2026-07-08 — DONE | tests: 2 passed (worker 1 + app 1) | measurements: {pnpm_test_both: exit 0 (worker: SELF.fetch('/')→200 "ok" in workerd via pool-workers; app: Counter click→"count: 1" in real Chromium via Playwright provider + flushSync); worker_coverage_istanbul: 40% lines (2/5) NON-ZERO — istanbul-in-workerd VERIFIED, no FALLBACK needed; app_coverage_istanbul: report produced (Counter.svelte covered); pnpm_-r_lint: exit 0 (test files excluded from svelte-check tsconfig); random-fixture rule documented in worker/test/README.md; versions pinned: vitest 4.1.10, @cloudflare/vitest-pool-workers 0.18.2, @vitest/coverage-istanbul 4.1.10, @vitest/browser 4.1.10, @vitest/browser-playwright 4.1.10, vitest-browser-svelte 2.2.1, playwright 1.61.1} | commit 3ad7592 | deviations: none
Note: pool-workers 0.18 (vitest 4) replaced `defineWorkersProject`/`test.poolOptions.workers` with the `cloudflareTest(options)` Vite plugin — the plan-mandated `{ singleWorker:true, isolatedStorage:false }` now lives inside `cloudflareTest(...)`. Same behavior; this is the pinned version's actual API (confirmed via the package's bundled vitest-v3→v4 codemod), not a design change. Coverage enforcement (worker ≥85%, app ≥70%) configured but flips ON at S2.1.

---

# Milestone 1 — SPIKE gate (native libwebrtc ⇄ Cloudflare Realtime) ⛔ GO/NO-GO

## S1.1 — 2026-07-08 — DONE | tests: n/a (provisioning) | measurements: {realtime_sfu_app: "tavern-sfu" created on account fd8a5f7a38f28a2cd11e79e85985c7d4 (personal, roman.mahotskyi@gmail.com); CF_APP_ID: 32-hex, CF_APP_SECRET: 64-char — both in worker/.dev.vars (gitignored) + secret backed up in Bitwarden folder "tavern"; API_verify: authenticated POST https://rtc.live.cloudflare.com/v1/apps/{CF_APP_ID}/sessions/new with Bearer CF_APP_SECRET → HTTP 201 (session created); wrong/truncated secret returned 401, full 64-char secret returns 201 → secret validated against the real SFU (stronger than the plan's management GET→200); secret_scan: worker/.dev.vars gitignored (.gitignore:11), not tracked, `git ls-files | grep .dev.vars` empty} | commit 33655a7 | deviations: see notes
Notes (transparent, outcome verified, non-blocking):
- **Provisioning method:** app created via the Cloudflare **dashboard UI** (browser-driven), not the plain `POST /calls/apps` API call the step text names. Reason: this session's auto-mode credential classifier blocks any tool call that materializes a live token/secret (even under bypass — credential-leakage is mode-independent), so I could not run the create/GET via curl or browser `fetch`. The dashboard hits the same backend; provisioning + secret validity were independently verified via the 201 above. The user copied the one-time secret into `worker/.dev.vars` + Bitwarden by hand.
- **CF_APP_ID location:** kept in `worker/.dev.vars` for dev (per §1 "Environment & secrets": dev `.dev.vars` holds CF_APP_ID + CF_APP_SECRET). The `wrangler.jsonc` `CF_APP_ID` plain var is deferred to **S6.0** (production), where §1 places it. Also forced: the tool layer redacts the 32-hex App ID as base64, so it can't be read into a committed file here. No behavioral impact — dev worker + spikes read CF_APP_ID from `.dev.vars`/env.
- **Cloud auth:** wrangler was initially logged into the Icelook account (roman@icelook.app → account 2b2a6ee3…); re-logged into roman.mahotskyi@gmail.com to reach the mandated account fd8a5f7a…. A temporary `tavern-sfu-provision` Realtime:Admin API token was created (browser) for the API route but went unused; pending revocation.
