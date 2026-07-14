import { useCallback, useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { MarketItem, PatchMarketItemRequest } from "@tavern/shared";
import {
  CheckIcon,
  CoinsIcon,
  ImagePlusIcon,
  LockIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";
import { useStore } from "zustand";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiError } from "@/lib/apiClient";
import { errorMessage } from "@/lib/errorMessage";
import { cn } from "@/lib/utils";
import { connectRoom } from "@/lib/wsClient";
import { m } from "@/paraglide/messages.js";
import { roomStore } from "@/stores/room";
import { useSessionStore } from "@/stores/session";
import { MarketIcon } from "./MarketIcon";
import { MarketIconPicker } from "./MarketIconPicker";
import {
  createMarketItem,
  deleteMarketItem,
  getMarketPage,
  marketKey,
  patchMarketItem,
  purchaseMarketItem,
} from "./marketApi";

type MarketScope = "shop" | "owned";

function useMarket(serverId: string, scope: MarketScope) {
  return useInfiniteQuery({
    queryKey: marketKey(serverId, scope),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => getMarketPage(serverId, scope, pageParam),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

function pointsLabel(points: number): string {
  return m.market_price({ points: points.toLocaleString() });
}

export function MarketTab({ serverId }: { serverId: string }) {
  const queryClient = useQueryClient();
  const userId = useSessionStore((state) => state.profile?.userId ?? null);
  const adminUserId = useStore(
    roomStore(serverId),
    (state) => state.serverMeta?.adminUserId ?? null,
  );
  const isAdmin = userId !== null && userId === adminUserId;
  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["market", serverId] });
  }, [queryClient, serverId]);
  useEffect(() => connectRoom(serverId).on("market.updated", invalidate), [invalidate, serverId]);

  return (
    <Tabs defaultValue="shop" className="h-full min-h-0 gap-0" data-testid="market-tab">
      <div className="shrink-0 border-b p-3">
        <TabsList variant="chip" className="bg-transparent">
          <TabsTrigger value="shop" data-testid="market-subtab-shop">
            {m.market_shop()}
          </TabsTrigger>
          <TabsTrigger value="owned" data-testid="market-subtab-owned">
            {m.market_my_icons()}
          </TabsTrigger>
          {isAdmin ? (
            <TabsTrigger value="manage" data-testid="market-subtab-manage">
              {m.market_manage()}
            </TabsTrigger>
          ) : null}
        </TabsList>
      </div>
      <TabsContent value="shop" className="min-h-0 overflow-y-auto p-3">
        <Shop serverId={serverId} />
      </TabsContent>
      <TabsContent value="owned" className="min-h-0 overflow-y-auto p-3">
        <MarketIconPicker serverId={serverId} />
      </TabsContent>
      {isAdmin ? (
        <TabsContent value="manage" className="min-h-0 overflow-y-auto p-3">
          <ManageMarket serverId={serverId} />
        </TabsContent>
      ) : null}
    </Tabs>
  );
}

function Shop({ serverId }: { serverId: string }) {
  const queryClient = useQueryClient();
  const query = useMarket(serverId, "shop");
  const items = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data]);
  const members = useStore(roomStore(serverId), (state) => state.members);
  const balance = useStore(roomStore(serverId), (state) => state.points.balance);
  const [selected, setSelected] = useState<MarketItem | null>(null);
  const [wearImmediately, setWearImmediately] = useState(false);
  const mutation = useMutation({
    mutationFn: (item: MarketItem) =>
      purchaseMarketItem(serverId, item.id, item.revision, wearImmediately),
    onSuccess: () => {
      toast(m.market_purchased());
      setSelected(null);
      setWearImmediately(false);
      void queryClient.invalidateQueries({ queryKey: ["market", serverId] });
    },
    onError: (error) => {
      if (error instanceof ApiError) toast(errorMessage(error.code));
      setSelected(null);
      void queryClient.invalidateQueries({ queryKey: marketKey(serverId, "shop") });
    },
  });

  return (
    <>
      {items.length === 0 && !query.isPending ? (
        <div className="flex min-h-48 items-center justify-center text-sm text-muted-foreground">
          {m.market_empty_shop()}
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => {
            const currentBuyer =
              item.purchase === null
                ? null
                : (members.find((member) => member.userId === item.purchase?.buyerId)
                    ?.displayName ?? item.purchase.buyerDisplayName);
            return (
              <li
                key={item.id}
                data-testid={`market-item-${item.id}`}
                className="flex gap-3 rounded-xl border bg-card p-3"
              >
                <span className="flex size-14 shrink-0 items-center justify-center rounded-lg bg-muted/70">
                  <MarketIcon
                    serverId={serverId}
                    itemId={item.id}
                    name={item.name}
                    className="size-12"
                  />
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <h3 className="truncate font-semibold">{item.name}</h3>
                  <span className="flex items-center gap-1 text-sm text-violet-500">
                    <CoinsIcon className="size-3.5" />
                    {pointsLabel(item.price)}
                  </span>
                  {item.purchase === null ? (
                    <span className="text-xs text-emerald-600">{m.market_available()}</span>
                  ) : (
                    <span className="truncate text-xs text-muted-foreground">
                      {m.market_sold_to({ name: currentBuyer ?? item.purchase.buyerDisplayName })}
                    </span>
                  )}
                  <Button
                    size="sm"
                    className="mt-auto self-start"
                    disabled={item.purchase !== null || balance < item.price}
                    onClick={() => {
                      setWearImmediately(false);
                      setSelected(item);
                    }}
                  >
                    {item.purchase === null ? m.market_buy() : m.market_sold()}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {query.hasNextPage ? (
        <Button
          variant="outline"
          className="mt-3 w-full"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {m.market_load_more()}
        </Button>
      ) : null}
      <AlertDialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) setSelected(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {m.market_purchase_title({ name: selected?.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {m.market_purchase_description({
                points: (selected?.price ?? 0).toLocaleString(),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border p-3">
            <input
              type="checkbox"
              data-testid="market-wear-immediately"
              checked={wearImmediately}
              onChange={(event) => setWearImmediately(event.target.checked)}
              className="size-4 accent-primary"
            />
            <span>{m.market_wear_immediately()}</span>
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={mutation.isPending}>{m.common_cancel()}</AlertDialogCancel>
            <AlertDialogAction
              disabled={selected === null || mutation.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (selected !== null) mutation.mutate(selected);
              }}
            >
              {m.market_buy()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function ManageMarket({ serverId }: { serverId: string }) {
  const queryClient = useQueryClient();
  const query = useMarket(serverId, "shop");
  const items = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data]);
  const profile = useSessionStore((state) => state.profile);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const previewUrl = useMemo(() => (file === null ? null : URL.createObjectURL(file)), [file]);
  useEffect(
    () => () => {
      if (previewUrl !== null) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["market", serverId] });
  };
  const createMutation = useMutation({
    mutationFn: () => {
      if (file === null) throw new Error("market image is required");
      return createMarketItem(serverId, { name, price: Number(price), file });
    },
    onSuccess: () => {
      setName("");
      setPrice("");
      setFile(null);
      invalidate();
      toast(m.market_item_created());
    },
    onError: (error) => {
      if (error instanceof ApiError) toast(errorMessage(error.code));
    },
  });
  const valid =
    file !== null && name.trim().length > 0 && Number.isInteger(Number(price)) && Number(price) > 0;

  return (
    <div className="grid gap-5">
      <form
        className="grid gap-4 rounded-xl border bg-card p-4 lg:grid-cols-[minmax(0,1fr)_minmax(220px,0.7fr)]"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) createMutation.mutate();
        }}
      >
        <div className="grid gap-3">
          <p className="text-sm text-muted-foreground">{m.market_manage_hint()}</p>
          <Label className="grid gap-1.5">
            <span>{m.market_name()}</span>
            <Input
              value={name}
              maxLength={32}
              data-testid="market-manage-name"
              onChange={(event) => setName(event.target.value)}
            />
          </Label>
          <Label className="grid gap-1.5">
            <span>{m.market_price_label()}</span>
            <Input
              value={price}
              type="number"
              min={1}
              step={1}
              data-testid="market-manage-price"
              onChange={(event) => setPrice(event.target.value)}
            />
          </Label>
          <Label className="grid gap-1.5">
            <span>{m.market_image()}</span>
            <span className="inline-flex w-fit cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 hover:bg-muted">
              <ImagePlusIcon className="size-4" />
              {m.market_choose_image()}
              <input
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                data-testid="market-manage-file"
                className="hidden"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
            </span>
          </Label>
          <Button
            type="submit"
            data-testid="market-manage-submit"
            disabled={!valid || createMutation.isPending}
            className="w-fit"
          >
            {m.market_add_item()}
          </Button>
        </div>
        <div className="flex min-h-40 flex-col items-center justify-center gap-3 rounded-lg bg-muted/50 p-4">
          <span className="text-xs font-medium text-muted-foreground">{m.market_preview()}</span>
          {previewUrl === null ? (
            <ImagePlusIcon className="size-12 text-muted-foreground/50" />
          ) : (
            <img src={previewUrl} alt="" className="size-12 object-contain" />
          )}
          <span className="flex items-center gap-1.5 font-medium" style={{ color: profile?.color }}>
            {profile?.displayName ?? ""}
            {previewUrl === null ? null : (
              <img src={previewUrl} alt="" className="size-5 object-contain" />
            )}
          </span>
        </div>
      </form>

      <ul className="grid gap-2">
        {items.map((item) => (
          <ManageItem key={item.id} serverId={serverId} item={item} onChanged={invalidate} />
        ))}
      </ul>
      {query.hasNextPage ? (
        <Button variant="outline" onClick={() => void query.fetchNextPage()}>
          {m.market_load_more()}
        </Button>
      ) : null}
    </div>
  );
}

function ManageItem({
  serverId,
  item,
  onChanged,
}: {
  serverId: string;
  item: MarketItem;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(item.name);
  const [price, setPrice] = useState(String(item.price));
  const patchMutation = useMutation({
    mutationFn: (patch: PatchMarketItemRequest) => patchMarketItem(serverId, item.id, patch),
    onSuccess: () => {
      setEditing(false);
      onChanged();
      toast(m.market_item_saved());
    },
    onError: (error) => {
      if (error instanceof ApiError) toast(errorMessage(error.code));
    },
  });
  const deleteMutation = useMutation({
    mutationFn: () => deleteMarketItem(serverId, item.id),
    onSuccess: () => {
      onChanged();
      toast(m.market_item_deleted());
    },
    onError: (error) => {
      if (error instanceof ApiError) toast(errorMessage(error.code));
    },
  });
  const sold = item.purchase !== null;

  return (
    <li className="flex flex-wrap items-center gap-3 rounded-xl border bg-card p-3">
      <MarketIcon serverId={serverId} itemId={item.id} name={item.name} className="size-10" />
      {editing ? (
        <form
          className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const next: PatchMarketItemRequest = {};
            if (name.trim() !== item.name) next.name = name.trim();
            if (Number(price) !== item.price) next.price = Number(price);
            if (Object.keys(next).length > 0) patchMutation.mutate(next);
            else setEditing(false);
          }}
        >
          <Input
            value={name}
            maxLength={32}
            onChange={(event) => setName(event.target.value)}
            className="w-48"
          />
          <Input
            type="number"
            min={1}
            step={1}
            value={price}
            onChange={(event) => setPrice(event.target.value)}
            className="w-32"
          />
          <Button size="sm" type="submit" disabled={patchMutation.isPending}>
            <CheckIcon />
            {m.common_save()}
          </Button>
          <Button size="sm" variant="ghost" type="button" onClick={() => setEditing(false)}>
            {m.common_cancel()}
          </Button>
        </form>
      ) : (
        <>
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{item.name}</div>
            <div className="text-xs text-muted-foreground">{pointsLabel(item.price)}</div>
          </div>
          {sold ? (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <LockIcon className="size-3.5" />
              {m.market_sold_locked()}
            </span>
          ) : (
            <>
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                <PencilIcon />
                {m.market_edit_item()}
              </Button>
              <AlertDialog>
                <AlertDialogTrigger render={<Button size="sm" variant="destructive" />}>
                  <Trash2Icon />
                  {m.market_delete_item()}
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{m.market_delete_item()}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {m.market_delete_confirm({ name: item.name })}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{m.common_cancel()}</AlertDialogCancel>
                    <AlertDialogAction
                      className={cn("text-destructive-foreground bg-destructive")}
                      onClick={() => deleteMutation.mutate()}
                    >
                      {m.market_delete_item()}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          )}
        </>
      )}
    </li>
  );
}
