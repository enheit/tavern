import { m } from "@/paraglide/messages.js";
import { Button } from "@/components/ui/button";
import { useBootStore } from "@/features/boot/bootStore";

// Rendered by BootGate when the boot machine hits `error` (the active server's hello.ok never
// arrived within the connect deadline). Retry re-runs the whole machine; the room sockets kept
// their own reconnect loop running underneath, so a recovered backend answers instantly.
export function BootError() {
  return (
    <div
      data-testid="boot-error"
      className="flex h-full w-full flex-col items-center justify-center gap-4"
    >
      <p className="text-muted-foreground">{m.boot_error()}</p>
      <Button variant="outline" onClick={() => useBootStore.getState().restart()}>
        {m.boot_retry()}
      </Button>
    </div>
  );
}
