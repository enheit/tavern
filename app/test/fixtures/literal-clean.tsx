// Fixture for the §9.6 literal-gate self-test: only i18n-routed copy + non-user-facing literals
// (data-testid, className). The gate must find nothing → exit 0.
import { m } from "@/paraglide/messages.js";

export function LiteralClean() {
  return (
    <button
      title={m.boot_loading()}
      aria-label={m.boot_loading()}
      data-testid="literal-clean"
      className="flex items-center"
    >
      {m.boot_loading()}
    </button>
  );
}
