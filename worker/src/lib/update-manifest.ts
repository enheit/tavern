import { z } from 'zod';

// S6.3 updater manifest (`/updates/latest.json`, tauri-plugin-updater "dynamic JSON"
// format). Pinned schema — the generation script and its unit test both validate
// against this, so a malformed manifest can never reach R2.

export const PLATFORMS = [
  'darwin-aarch64',
  'darwin-x86_64',
  'windows-x86_64',
  'linux-x86_64',
] as const;

export const manifestSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  notes: z.string(),
  pub_date: z.string().datetime(),
  platforms: z
    .record(
      z.enum(PLATFORMS),
      z.object({
        // minisign signature (contents of the .sig the bundler emits)
        signature: z.string().min(1),
        url: z.string().url(),
      }),
    )
    .refine((p) => Object.keys(p).length > 0, { message: 'at least one platform' }),
});

export type UpdateManifest = z.infer<typeof manifestSchema>;

export interface PlatformArtifact {
  platform: (typeof PLATFORMS)[number];
  signature: string;
  /// Bundle filename as uploaded to R2 (served at <base>/updates/<file>).
  file: string;
}

/// Build + validate the manifest. `baseUrl` is the worker origin (no trailing slash).
export function buildManifest(args: {
  version: string;
  notes: string;
  pubDate: string;
  baseUrl: string;
  artifacts: PlatformArtifact[];
}): UpdateManifest {
  const platforms: Record<string, { signature: string; url: string }> = {};
  for (const a of args.artifacts) {
    platforms[a.platform] = {
      signature: a.signature,
      url: `${args.baseUrl}/updates/${encodeURIComponent(a.file)}`,
    };
  }
  return manifestSchema.parse({
    version: args.version,
    notes: args.notes,
    pub_date: args.pubDate,
    platforms,
  });
}
