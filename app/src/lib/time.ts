// FR-39 relative timestamps for the Activity tab. `Intl.RelativeTimeFormat` only — no date library
// (R2). Pinned unit thresholds: <60s → seconds · <60min → minutes · <24h → hours · otherwise days.
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

export function formatRelativeTime(at: number, locale: string): string {
  // Negative diff = in the past; `numeric: "auto"` yields natural copy ("now", "yesterday").
  const diffMs = at - Date.now();
  const abs = Math.abs(diffMs);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (abs < MS_PER_MINUTE) return rtf.format(Math.round(diffMs / MS_PER_SECOND), "second");
  if (abs < MS_PER_HOUR) return rtf.format(Math.round(diffMs / MS_PER_MINUTE), "minute");
  if (abs < MS_PER_DAY) return rtf.format(Math.round(diffMs / MS_PER_HOUR), "hour");
  return rtf.format(Math.round(diffMs / MS_PER_DAY), "day");
}
