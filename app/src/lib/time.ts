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

// FR-40 stream/watch durations for the Stats tab. Format `h:mm`: hours carry no leading zero, minutes
// are floor-rounded (a partial minute never rounds up) and zero-padded to two digits — 0 → "0:00",
// 59 → "0:00", 60 → "0:01", 3661 → "1:01", 445500 → "123:45". No date library (R2).
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;

export function formatHoursMinutes(seconds: number): string {
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / SECONDS_PER_HOUR);
  const minutes = Math.floor((whole % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  return `${hours}:${String(minutes).padStart(2, "0")}`;
}
