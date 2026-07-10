import { m } from "@/paraglide/messages.js";
import { cn } from "@/lib/utils";

// Frozen test id `boot-loader` (used by S4.3's boot gate + later e2e). Rendered as the router's
// HydrateFallback while lazy route modules resolve.
export function BootLoader() {
  return (
    <div
      data-testid="boot-loader"
      className={cn("flex h-full w-full items-center justify-center text-muted-foreground")}
    >
      {m.boot_loading()}
    </div>
  );
}
