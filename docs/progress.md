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
CI (bundle green on all 3 runners): verified via origin/main push this session — see run recorded below.
