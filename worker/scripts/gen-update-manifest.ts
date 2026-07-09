// S6.3 updater manifest generator. Node ≥23.6 (type stripping). Usage:
//
//   node scripts/gen-update-manifest.ts \
//     --version 0.1.1 --notes "fixes" \
//     --base https://tavern.roman-mahotskyi.workers.dev \
//     --artifact darwin-aarch64:path/to/Tavern.app.tar.gz:path/to/Tavern.app.tar.gz.sig \
//     [--artifact <platform>:<bundle>:<sig> ...] \
//     [-o latest.json]
//
// Output is validated against the pinned zod schema (worker/src/lib/update-manifest.ts)
// before it is written — a malformed manifest can never reach R2.

import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { buildManifest, type PlatformArtifact, PLATFORMS } from '../src/lib/update-manifest.ts';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const version = flag('--version');
const base = flag('--base');
if (!version || !base) {
  console.error('required: --version X.Y.Z --base <worker origin> --artifact platform:bundle:sig');
  process.exit(2);
}

const artifacts: PlatformArtifact[] = [];
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] !== '--artifact') continue;
  const [platform, bundle, sig] = process.argv[i + 1].split(':');
  if (!(PLATFORMS as readonly string[]).includes(platform) || !bundle || !sig) {
    console.error(`bad --artifact (want platform:bundle:sig with platform ∈ ${PLATFORMS.join('|')})`);
    process.exit(2);
  }
  artifacts.push({
    platform: platform as PlatformArtifact['platform'],
    signature: readFileSync(sig, 'utf8').trim(),
    file: basename(bundle),
  });
}

const manifest = buildManifest({
  version,
  notes: flag('--notes') ?? '',
  pubDate: new Date().toISOString(),
  baseUrl: base.replace(/\/$/, ''),
  artifacts,
});

const out = flag('-o');
const json = JSON.stringify(manifest, null, 2);
if (out) writeFileSync(out, json + '\n');
else console.log(json);
