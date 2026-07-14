import { CloudflareUsageResponse } from "@tavern/shared";
import type { CloudflareUsageStatus, MediaUsageCategory } from "@tavern/shared";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { apiClient } from "@/lib/apiClient";
import { m } from "@/paraglide/messages.js";

const CATEGORY_LABEL: Record<MediaUsageCategory, () => string> = {
  avatars: () => m.settings_cloudflare_avatars(),
  soundboardAudio: () => m.settings_cloudflare_soundboard(),
  recordings: () => m.settings_cloudflare_recordings(),
  screenshots: () => m.settings_cloudflare_screenshots(),
  chatImages: () => m.settings_cloudflare_chat_images(),
  marketIcons: () => m.settings_cloudflare_market_icons(),
  other: () => m.settings_cloudflare_other(),
};

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatBytes(value: number): string {
  if (value < 1_000) return `${formatNumber(value)} B`;
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)} KB`;
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
  return `${(value / 1_000_000_000).toFixed(2)} GB`;
}

function statusText(status: CloudflareUsageStatus, updatedAt: number | null): string {
  if (status === "unavailable" || updatedAt === null) return m.settings_cloudflare_unavailable();
  const time = new Date(updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return status === "stale"
    ? m.settings_cloudflare_stale()
    : m.settings_cloudflare_updated({ time });
}

function UsageCard({
  title,
  status,
  updatedAt,
  children,
}: {
  title: string;
  status: CloudflareUsageStatus;
  updatedAt: number | null;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border p-3" data-status={status}>
      <div className="flex items-baseline justify-between gap-3">
        <h4 className="text-sm font-medium">{title}</h4>
        <span className="text-[11px] text-muted-foreground">{statusText(status, updatedAt)}</span>
      </div>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value ?? m.settings_cloudflare_unavailable()}</span>
    </div>
  );
}

export function CloudflareUsage() {
  const query = useQuery({
    queryKey: ["cloudflare-usage"],
    queryFn: () => apiClient.get("/api/me/cloudflare-usage", CloudflareUsageResponse),
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });

  if (query.data === undefined) {
    return (
      <section data-testid="settings-cloudflare-usage" className="border-t pt-4">
        <h3 className="text-sm font-medium">{m.settings_cloudflare_title()}</h3>
        <p className="mt-2 text-xs text-muted-foreground">{m.settings_cloudflare_unavailable()}</p>
      </section>
    );
  }

  const usage = query.data;
  return (
    <section data-testid="settings-cloudflare-usage" className="flex flex-col gap-3 border-t pt-4">
      <header>
        <h3 className="text-sm font-medium">{m.settings_cloudflare_title()}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{m.settings_cloudflare_note()}</p>
        <p className="mt-1 text-xs text-muted-foreground">{m.settings_cloudflare_month()}</p>
      </header>

      <UsageCard
        title={m.settings_cloudflare_media()}
        status={usage.media.status}
        updatedAt={usage.media.updatedAt}
      >
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <span className="text-lg font-semibold tabular-nums">
            {usage.media.bytes === null
              ? m.settings_cloudflare_unavailable()
              : formatBytes(usage.media.bytes)}
          </span>
          <span className="text-xs text-muted-foreground">
            {usage.media.objectCount === null
              ? m.settings_cloudflare_unavailable()
              : m.settings_cloudflare_objects({ count: formatNumber(usage.media.objectCount) })}
          </span>
        </div>
        <div className="grid gap-1">
          {usage.media.categories.map((category) => (
            <Metric
              key={category.category}
              label={CATEGORY_LABEL[category.category]()}
              value={formatBytes(category.bytes)}
            />
          ))}
        </div>
      </UsageCard>

      <div className="grid gap-3 sm:grid-cols-2">
        <UsageCard
          title={m.settings_cloudflare_r2()}
          status={usage.r2.status}
          updatedAt={usage.r2.updatedAt}
        >
          <Metric
            label={m.settings_cloudflare_requests()}
            value={usage.r2.operations === null ? null : formatNumber(usage.r2.operations)}
          />
        </UsageCard>
        <UsageCard
          title={m.settings_cloudflare_d1()}
          status={usage.d1.status}
          updatedAt={usage.d1.updatedAt}
        >
          <Metric
            label={m.settings_cloudflare_storage()}
            value={usage.d1.storageBytes === null ? null : formatBytes(usage.d1.storageBytes)}
          />
          <Metric
            label={m.settings_cloudflare_rows_read()}
            value={usage.d1.rowsRead === null ? null : formatNumber(usage.d1.rowsRead)}
          />
          <Metric
            label={m.settings_cloudflare_rows_written()}
            value={usage.d1.rowsWritten === null ? null : formatNumber(usage.d1.rowsWritten)}
          />
        </UsageCard>
        <UsageCard
          title={m.settings_cloudflare_do()}
          status={usage.durableObjects.status}
          updatedAt={usage.durableObjects.updatedAt}
        >
          <Metric
            label={m.settings_cloudflare_requests()}
            value={
              usage.durableObjects.requests === null
                ? null
                : formatNumber(usage.durableObjects.requests)
            }
          />
          <Metric
            label={m.settings_cloudflare_cpu()}
            value={
              usage.durableObjects.cpuTimeMs === null
                ? null
                : `${formatNumber(Math.round(usage.durableObjects.cpuTimeMs))} ms`
            }
          />
          <Metric
            label={m.settings_cloudflare_storage()}
            value={
              usage.durableObjects.storageBytes === null
                ? null
                : formatBytes(usage.durableObjects.storageBytes)
            }
          />
        </UsageCard>
        <UsageCard
          title={m.settings_cloudflare_worker()}
          status={usage.worker.status}
          updatedAt={usage.worker.updatedAt}
        >
          <Metric
            label={m.settings_cloudflare_requests()}
            value={usage.worker.requests === null ? null : formatNumber(usage.worker.requests)}
          />
          <Metric
            label={m.settings_cloudflare_errors()}
            value={usage.worker.errors === null ? null : formatNumber(usage.worker.errors)}
          />
          <Metric
            label={m.settings_cloudflare_cpu()}
            value={
              usage.worker.cpuTimeMs === null
                ? null
                : `${formatNumber(Math.round(usage.worker.cpuTimeMs))} ms`
            }
          />
        </UsageCard>
        <UsageCard
          title={m.settings_cloudflare_turn()}
          status={usage.turn.status}
          updatedAt={usage.turn.updatedAt}
        >
          <Metric
            label={m.settings_cloudflare_ingress()}
            value={usage.turn.ingressBytes === null ? null : formatBytes(usage.turn.ingressBytes)}
          />
          <Metric
            label={m.settings_cloudflare_egress()}
            value={usage.turn.egressBytes === null ? null : formatBytes(usage.turn.egressBytes)}
          />
        </UsageCard>
        <UsageCard
          title={m.settings_cloudflare_analytics()}
          status={usage.analyticsEngine.status}
          updatedAt={usage.analyticsEngine.updatedAt}
        >
          <Metric
            label={m.settings_cloudflare_points()}
            value={
              usage.analyticsEngine.pointsWritten === null
                ? null
                : formatNumber(usage.analyticsEngine.pointsWritten)
            }
          />
        </UsageCard>
      </div>

      <UsageCard
        title={m.settings_cloudflare_sfu()}
        status={usage.sfu.status}
        updatedAt={usage.sfu.updatedAt}
      >
        <p className="text-xs text-muted-foreground">{m.settings_cloudflare_sfu_note()}</p>
      </UsageCard>
      <UsageCard
        title={m.settings_cloudflare_rate_limiter()}
        status={usage.rateLimiter.status}
        updatedAt={usage.rateLimiter.updatedAt}
      >
        <p className="text-xs text-muted-foreground">{m.settings_cloudflare_rate_limiter_note()}</p>
      </UsageCard>
      <UsageCard
        title={m.settings_cloudflare_assets()}
        status={usage.staticAssets.status}
        updatedAt={usage.staticAssets.updatedAt}
      >
        <p className="text-xs text-muted-foreground">{m.settings_cloudflare_assets_note()}</p>
      </UsageCard>
    </section>
  );
}
