import type { ActivityEntry, ActivityType, Member } from "@tavern/shared";
import { formatRelativeTime } from "@/lib/time";
import { m } from "@/paraglide/messages.js";

// FR-39 one activity row: glyph + i18n template + relative time. One entry per `activity.types`
// value (App-A). The `{name}` parameter resolves through the room-store member map; an unknown
// userId (departed member) falls back to `m.activity_former_member()`.

// Per-type i18n mapping (pinned constant ACTIVITY_I18N). Values are the bound Paraglide message
// functions, NOT raw key strings: §9.6 forbids dynamic `m[key]` access (breaks tree-shaking /
// go-to-definition), so a Record<_, string> of key names cannot be looked up here — this object
// references every `m.activity_*` statically, which tree-shakes identically to a switch.
const ACTIVITY_I18N: Record<ActivityType, (args: { name: string }) => string> = {
  "voice.join": m.activity_voice_join,
  "voice.leave": m.activity_voice_leave,
  "stream.start": m.activity_stream_start,
  "stream.stop": m.activity_stream_stop,
  "rec.start": m.activity_rec_start,
  "rec.stop": m.activity_rec_stop,
  "member.join": m.activity_member_join,
  "member.kick": m.activity_member_kick,
};

// Pinned 2-letter monochrome glyph fallback (lucide-react is not in §3 — R2). CSS-only, no dep.
const ACTIVITY_GLYPH: Record<ActivityType, string> = {
  "voice.join": "VJ",
  "voice.leave": "VL",
  "stream.start": "SS",
  "stream.stop": "SX",
  "rec.start": "RS",
  "rec.stop": "RX",
  "member.join": "MJ",
  "member.kick": "MK",
};

export function ActivityRow({
  entry,
  members,
  locale,
}: {
  entry: ActivityEntry;
  members: Member[];
  locale: string;
}) {
  const member = members.find((mem) => mem.userId === entry.userId);
  const name = member?.displayName ?? m.activity_former_member();
  const label = ACTIVITY_I18N[entry.type]({ name });
  return (
    <li
      data-testid="activity-row"
      data-activity-id={entry.id}
      data-activity-type={entry.type}
      className="flex items-center gap-2 px-3 py-1.5"
    >
      <span
        aria-hidden={true}
        className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-[0.65rem] font-semibold tracking-tight text-muted-foreground"
      >
        {ACTIVITY_GLYPH[entry.type]}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
      <time className="shrink-0 text-xs text-muted-foreground">
        {formatRelativeTime(entry.at, locale)}
      </time>
    </li>
  );
}
