import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "../harness/fixtures";

// Unit check for the harness itself (kept under web/** so the `web` project actually runs it, §10).
const here = path.dirname(fileURLToPath(import.meta.url));
const TONE_WAV = path.resolve(here, "..", "fixtures", "tone-440hz-10s.wav");

test.describe("harness self-test", () => {
  test("api.createUser yields distinct users", async ({ api }) => {
    const first = await api.createUser("self");
    const second = await api.createUser("self");
    expect(first.username).not.toBe(second.username);
    expect(first.userId).not.toBe(second.userId);
  });

  test("tone WAV fixture is 48 kHz mono PCM", async () => {
    const buf = await readFile(TONE_WAV);
    expect(buf.toString("ascii", 0, 4)).toBe("RIFF");
    expect(buf.toString("ascii", 8, 12)).toBe("WAVE");
    // Read the fmt fields at bytes 22–28: NumChannels (22) + SampleRate (24).
    expect(buf.readUInt16LE(22)).toBe(1);
    expect(buf.readUInt32LE(24)).toBe(48_000);
    expect(buf.readUInt16LE(34)).toBe(16);
  });
});
