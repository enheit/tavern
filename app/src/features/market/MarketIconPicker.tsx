import { useCallback, useEffect, useMemo } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, CircleOffIcon } from "lucide-react";
import { toast } from "sonner";
import { useStore } from "zustand";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/apiClient";
import { errorMessage } from "@/lib/errorMessage";
import { cn } from "@/lib/utils";
import { connectRoom } from "@/lib/wsClient";
import { m } from "@/paraglide/messages.js";
import { roomStore } from "@/stores/room";
import { useSessionStore } from "@/stores/session";
import { MarketIcon } from "./MarketIcon";
import { equipMarketIcon, getMarketPage, marketKey } from "./marketApi";

export function MarketIconPicker({ serverId }: { serverId: string }) {
  const queryClient = useQueryClient();
  const userId = useSessionStore((state) => state.profile?.userId ?? null);
  const equippedId = useStore(
    roomStore(serverId),
    (state) => state.members.find((member) => member.userId === userId)?.marketIcon?.itemId ?? null,
  );
  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: marketKey(serverId, "owned") });
  }, [queryClient, serverId]);
  useEffect(() => connectRoom(serverId).on("market.updated", invalidate), [invalidate, serverId]);

  const query = useInfiniteQuery({
    queryKey: marketKey(serverId, "owned"),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => getMarketPage(serverId, "owned", pageParam),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const items = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data]);
  const mutation = useMutation({
    mutationFn: (itemId: string | null) => equipMarketIcon(serverId, itemId),
    onSuccess: () => toast(m.market_equipped()),
    onError: (error) => {
      if (error instanceof ApiError) toast(errorMessage(error.code));
    },
  });

  return (
    <section className="grid gap-2" data-testid="market-icon-picker">
      <button
        type="button"
        data-testid="market-owned-none"
        disabled={mutation.isPending}
        onClick={() => mutation.mutate(null)}
        className={cn(
          "flex items-center gap-3 rounded-lg border p-3 text-left hover:bg-muted/60",
          equippedId === null && "border-primary bg-primary/5",
        )}
      >
        <CircleOffIcon className="size-8 text-muted-foreground" />
        <span className="flex-1 font-medium">{m.market_none()}</span>
        {equippedId === null ? <CheckIcon className="size-4 text-primary" /> : null}
      </button>
      {items.map((item) => {
        const selected = item.id === equippedId;
        return (
          <button
            key={item.id}
            type="button"
            data-testid={`market-owned-${item.id}`}
            disabled={mutation.isPending}
            onClick={() => mutation.mutate(item.id)}
            className={cn(
              "flex items-center gap-3 rounded-lg border p-3 text-left hover:bg-muted/60",
              selected && "border-primary bg-primary/5",
            )}
          >
            <MarketIcon serverId={serverId} itemId={item.id} name={item.name} className="size-8" />
            <span className="min-w-0 flex-1 truncate font-medium">{item.name}</span>
            <span className="text-xs text-muted-foreground">
              {selected ? m.market_wearing() : m.market_wear()}
            </span>
            {selected ? <CheckIcon className="size-4 text-primary" /> : null}
          </button>
        );
      })}
      {items.length === 0 && !query.isPending ? (
        <p className="py-3 text-center text-sm text-muted-foreground">{m.market_empty_owned()}</p>
      ) : null}
      {query.hasNextPage ? (
        <Button
          type="button"
          variant="outline"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {m.market_load_more()}
        </Button>
      ) : null}
    </section>
  );
}
