import { useEffect, useState } from "react";
import { m } from "@/paraglide/messages.js";
import { platform } from "@/platform/types";

// FR-44: appears once the desktop main reports a downloaded update (update://ready → bridge);
// clicking hands control back to the updater (quitAndInstall). Web never fires the event, so the
// pill simply never renders there. Hidden by default — no reserved layout space.
export function UpdatePill() {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => platform.updates.onUpdateReady((info) => setVersion(info.version)), []);

  if (version === null) return null;
  return (
    <button
      type="button"
      data-testid="update-pill"
      onClick={() => {
        platform.updates.restartToUpdate();
      }}
      className="shrink-0 rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"
    >
      {m.shell_update_pill_label({ version })}
    </button>
  );
}
