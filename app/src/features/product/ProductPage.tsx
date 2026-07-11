import { DownloadIcon, GlobeIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages.js";

// Public landing page (/product): one screen, no scroll — a platform-detected primary download
// button plus an "open in browser" escape hatch, Discord-style. Release artifacts carry the version
// in their filenames (Tavern-X.Y.Z-arm64.dmg…), so there is no stable "latest" asset URL to hardcode;
// the page asks the GitHub API for the latest release and falls back to the releases page until (or
// if never) that resolves.
const REPO = "enheit/tavern";
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

type Platform = "mac" | "windows" | "linux";

type LatestRelease = {
  tag_name?: string;
  assets?: { name?: string; browser_download_url?: string }[];
};

function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  if (/Mac|iPhone|iPad/i.test(ua)) return "mac";
  if (/Linux|X11/i.test(ua) && !/Android/i.test(ua)) return "linux";
  return "windows";
}

const PLATFORM_LABELS: Record<Platform, { download: () => string; name: () => string }> = {
  mac: { download: m.product_download_mac, name: m.product_platform_mac },
  windows: { download: m.product_download_windows, name: m.product_platform_windows },
  linux: { download: m.product_download_linux, name: m.product_platform_linux },
};

function assetPlatform(name: string): Platform | null {
  if (name.endsWith(".dmg")) return "mac";
  if (name.endsWith(".exe")) return "windows";
  if (name.endsWith(".AppImage")) return "linux";
  return null;
}

export function ProductPage() {
  const [platform] = useState(detectPlatform);
  const [downloads, setDownloads] = useState<Partial<Record<Platform, string>>>({});
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
          signal: controller.signal,
          headers: { Accept: "application/vnd.github+json" },
        });
        if (!res.ok) return;
        const release = (await res.json()) as LatestRelease;
        const links: Partial<Record<Platform, string>> = {};
        for (const asset of release.assets ?? []) {
          if (asset.name === undefined || asset.browser_download_url === undefined) continue;
          const target = assetPlatform(asset.name);
          if (target !== null) links[target] = asset.browser_download_url;
        }
        setDownloads(links);
        setVersion(release.tag_name ?? null);
      } catch {
        // Rate-limited/offline — buttons keep pointing at the releases page.
      }
    })();
    return () => controller.abort();
  }, []);

  const others = (["mac", "windows", "linux"] as const).filter((p) => p !== platform);

  return (
    <div
      data-testid="page-product"
      className="flex h-dvh w-full flex-col items-center justify-center gap-8 overflow-hidden bg-background p-6 text-foreground"
    >
      <div className="flex flex-col items-center gap-4">
        <img
          src="/tavern-logo-minified.png"
          alt={m.product_logo_alt()}
          className="size-28 rounded-[28px] shadow-lg"
        />
        <h1 className="text-4xl font-bold tracking-tight">{m.product_title()}</h1>
        <p className="max-w-md text-center text-muted-foreground">{m.product_tagline()}</p>
      </div>

      <div className="flex flex-col items-center gap-3">
        <Button
          render={<a href={downloads[platform] ?? RELEASES_PAGE} />}
          className="h-11 px-6 text-base"
          data-testid="download-primary"
        >
          <DownloadIcon />
          {PLATFORM_LABELS[platform].download()}
        </Button>
        <Button
          render={<Link to="/" />}
          variant="outline"
          className="h-11 px-6 text-base"
          data-testid="open-browser"
        >
          <GlobeIcon />
          {m.product_open_browser()}
        </Button>
      </div>

      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span>{m.product_also_available()}</span>
        {others.map((p) => (
          <a
            key={p}
            href={downloads[p] ?? RELEASES_PAGE}
            data-testid={`download-${p}`}
            className="text-foreground underline-offset-4 hover:underline"
          >
            {PLATFORM_LABELS[p].name()}
          </a>
        ))}
      </div>

      <a
        href={RELEASES_PAGE}
        className="text-xs text-muted-foreground underline-offset-4 hover:underline"
      >
        {version !== null ? `${m.product_all_releases()} · ${version}` : m.product_all_releases()}
      </a>
    </div>
  );
}
