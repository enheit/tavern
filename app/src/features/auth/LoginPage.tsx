import { cn } from "@/lib/utils";

// Placeholder route shell (frozen test id `page-login`). Real auth UI lands in a later step.
export function LoginPage() {
  return (
    <div
      data-testid="page-login"
      className={cn("flex h-full w-full items-center justify-center")}
    />
  );
}
