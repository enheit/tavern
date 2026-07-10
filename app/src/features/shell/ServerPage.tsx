import { cn } from "@/lib/utils";

// Placeholder route shell (frozen test id `page-server`). Real server shell lands in a later step.
export function ServerPage() {
  return (
    <div
      data-testid="page-server"
      className={cn("flex h-full w-full items-center justify-center")}
    />
  );
}
