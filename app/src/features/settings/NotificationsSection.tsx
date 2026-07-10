import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { m } from "@/paraglide/messages.js";
import { platform } from "@/platform/types";
import { useSettingsStore } from "@/stores/settings";
import { persistSettings } from "./AppSection";

// The permission-denied toast is shown at most once per session (pinned "one-time toast").
let deniedToastShown = false;
function showDeniedToastOnce(): void {
  if (deniedToastShown) return;
  deniedToastShown = true;
  toast(m.settings_notifications_denied());
}

// FR-16 per-account notification toggles. Enabling a toggle is the pinned user gesture on which
// permission is requested (through the platform bridge — the renderer never touches Notification
// directly); a denial shows the one-time toast and no-ops. Every change persists the full row.
export function NotificationsSection() {
  const notifyAll = useSettingsStore((s) => s.notifyAll);
  const notifyMentions = useSettingsStore((s) => s.notifyMentions);
  const setNotifyAll = useSettingsStore((s) => s.setNotifyAll);
  const setNotifyMentions = useSettingsStore((s) => s.setNotifyMentions);

  const toggle = async (apply: (next: boolean) => void, next: boolean): Promise<void> => {
    if (next && !(await platform.notifications.requestPermission())) {
      showDeniedToastOnce();
      return;
    }
    apply(next);
    await persistSettings();
  };

  return (
    <div data-testid="settings-notifications" className="flex flex-col gap-4 py-2">
      <label className="flex items-center justify-between gap-4 text-sm">
        <span>{m.settings_notifications_all()}</span>
        <Switch
          checked={notifyAll}
          data-testid="settings-notify-all"
          onCheckedChange={(next) => void toggle(setNotifyAll, next)}
        />
      </label>
      <label className="flex items-center justify-between gap-4 text-sm">
        <span>{m.settings_notifications_mentions()}</span>
        <Switch
          checked={notifyMentions}
          data-testid="settings-notify-mentions"
          onCheckedChange={(next) => void toggle(setNotifyMentions, next)}
        />
      </label>
    </div>
  );
}
