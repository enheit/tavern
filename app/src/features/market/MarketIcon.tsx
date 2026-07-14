import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { fetchMarketIcon } from "./marketApi";

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
  const query = useQuery({
    queryKey: ["market-icon", serverId, itemId],
    queryFn: ({ signal }) => fetchMarketIcon(serverId, itemId, signal),
    staleTime: Infinity,
  });
  const [source, setSource] = useState<string | null>(null);

  useEffect(() => {
    if (query.data === undefined) {
      setSource(null);
      return;
    }
    const objectUrl = URL.createObjectURL(query.data);
    setSource(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [query.data]);

  if (source === null) {
    return (
      <span
        role="img"
        aria-label={name}
        title={name}
        data-market-icon-status={query.isError ? "error" : "loading"}
        className={cn("inline-block size-5 shrink-0 rounded-sm bg-muted/60", className)}
      />
    );
  }

  return (
    <img
      src={source}
      alt={name}
      title={name}
      data-testid={testId}
      className={cn("size-5 shrink-0 object-contain", className)}
    />
  );
}
