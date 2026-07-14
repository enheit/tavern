import { cn } from "@/lib/utils";
import { marketIconUrl } from "./marketApi";

export function MarketIcon({
  serverId,
  itemId,
  name,
  className,
  testId,
}: {
  serverId: string;
  itemId: string;
  name: string;
  className?: string;
  testId?: string;
}) {
  return (
    <img
      src={marketIconUrl(serverId, itemId)}
      alt={name}
      title={name}
      data-testid={testId}
      className={cn("size-5 shrink-0 object-contain", className)}
    />
  );
}
