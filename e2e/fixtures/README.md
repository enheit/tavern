# e2e test fixtures

Binary media fixtures used by the Playwright e2e suites. **All fixtures are committed, never
generated at test time** (§10) so CI is deterministic and offline.

## `beep.mp3` (S9.1 — soundboard)

- **What:** a 1-second, 440 Hz sine tone encoded as MP3 (mono, VBR, ~4.8 KB).
- **Provenance:** public-domain synthetic tone (an `ffmpeg` `lavfi` `sine` source — no third-party
  audio). Generated **once** and committed; the soundboard upload e2e (S9.2) uploads it as a real mp3.
- **Regenerate (only if ever needed), from `e2e/fixtures/`:**

  ```sh
  ffmpeg -f lavfi -i "sine=frequency=440:duration=1" -codec:a libmp3lame -qscale:a 9 beep.mp3
  ```

## `tone-440hz-10s.wav` / `motion-160x120.y4m` (S4.4 — fake media)

Fake-media inputs for Electron/Chromium (`use-file-for-fake-audio-capture` tone WAV + a fake-video
Y4M). Provenance and the generator live in `e2e/scripts/gen-fixtures.mjs`.
