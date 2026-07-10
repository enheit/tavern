// Regenerates the committed fake-media fixtures used by the Playwright harness (PLAN §10). Node
// stdlib only — no deps. Output is fully deterministic (pure math), so re-running yields
// byte-identical files: the DoD gate is `node e2e/scripts/gen-fixtures.mjs && git diff --exit-code
// e2e/fixtures`. The fixtures are COMMITTED; this script exists for regeneration/audit, not to run
// at test time.
//
//   tone-440hz-10s.wav  — RIFF PCM, 48 kHz mono 16-bit, 440 Hz sine, amplitude 0.5, 10 s. RMS of a
//                         0.5-amplitude sine ≈ 0.354, comfortably above §App-B speakingRmsThreshold
//                         (0.02) — the default fake-device "beep" never clears that bar, which is
//                         exactly why the speaking-indicator e2e needs a real tone.
//   motion-160x120.y4m  — YUV4MPEG2 4:2:0, 160×120, 15 fps, 2 s, fill colour flipped every 500 ms so
//                         the encoder actually emits frames (a static image would be dropped).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "fixtures");

// ── tone-440hz-10s.wav ────────────────────────────────────────────────────────────────────────
const SAMPLE_RATE = 48_000;
const CHANNELS = 1;
const BITS = 16;
const FREQ_HZ = 440;
const AMPLITUDE = 0.5;
const DURATION_S = 10;

function buildWav() {
  const bytesPerSample = BITS / 8;
  const numSamples = SAMPLE_RATE * DURATION_S;
  const dataSize = numSamples * CHANNELS * bytesPerSample;
  const byteRate = SAMPLE_RATE * CHANNELS * bytesPerSample;
  const blockAlign = CHANNELS * bytesPerSample;

  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); // PCM fmt chunk size
  buf.writeUInt16LE(1, 20); // AudioFormat = PCM
  buf.writeUInt16LE(CHANNELS, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(BITS, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);

  const peak = AMPLITUDE * 32_767;
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.round(peak * Math.sin((2 * Math.PI * FREQ_HZ * i) / SAMPLE_RATE));
    buf.writeInt16LE(sample, 44 + i * bytesPerSample);
  }
  return buf;
}

// ── motion-160x120.y4m ────────────────────────────────────────────────────────────────────────
const Y4M_W = 160;
const Y4M_H = 120;
const Y4M_FPS = 15;
const Y4M_DURATION_S = 2;
const FLIP_EVERY_S = 0.5;

// Two distinct fill colours (BT.601 Y'CbCr). Alternating them each 500 ms guarantees inter-frame
// change so the video encoder never treats the source as static.
const COLOURS = [
  { y: 81, u: 90, v: 240 }, // reddish
  { y: 145, u: 54, v: 34 }, // greenish
];

function buildY4m() {
  const header = Buffer.from(
    `YUV4MPEG2 W${Y4M_W} H${Y4M_H} F${Y4M_FPS}:1 Ip A1:1 C420jpeg\n`,
    "ascii",
  );
  const frameMarker = Buffer.from("FRAME\n", "ascii");
  const ySize = Y4M_W * Y4M_H;
  const cSize = (Y4M_W / 2) * (Y4M_H / 2);
  const numFrames = Y4M_FPS * Y4M_DURATION_S;
  const framesPerBucket = Y4M_FPS * FLIP_EVERY_S;

  const parts = [header];
  for (let f = 0; f < numFrames; f++) {
    const colour = COLOURS[Math.floor(f / framesPerBucket) % COLOURS.length];
    const plane = Buffer.alloc(ySize + 2 * cSize);
    plane.fill(colour.y, 0, ySize);
    plane.fill(colour.u, ySize, ySize + cSize);
    plane.fill(colour.v, ySize + cSize, ySize + 2 * cSize);
    parts.push(frameMarker, plane);
  }
  return Buffer.concat(parts);
}

mkdirSync(fixturesDir, { recursive: true });
writeFileSync(join(fixturesDir, "tone-440hz-10s.wav"), buildWav());
writeFileSync(join(fixturesDir, "motion-160x120.y4m"), buildY4m());
console.log("wrote e2e/fixtures/tone-440hz-10s.wav + e2e/fixtures/motion-160x120.y4m");
