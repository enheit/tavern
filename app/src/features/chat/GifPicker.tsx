import type { GifResult } from "@tavern/shared";
import { GifSearchResponse } from "@tavern/shared";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { apiClient } from "@/lib/apiClient";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { m } from "@/paraglide/messages.js";

// § GIF picker: a search box + result grid living in the Composer's popover (mirrors the emoji picker
// idiom). Empty query shows provider trending; typing (debounced) searches. Clicking a tile fires
// `onPick` — the Composer turns the result into a message. Search hits the Worker proxy `/api/gifs`
// (the provider key stays server-side); results are the vendor-agnostic shared `GifResult`. Results
// paginate via the provider's opaque `next` cursor (passed back as `&pos=`) with an infinite query — a
// bottom sentinel pulls the next page as it scrolls into view.
const DEBOUNCE_MS = 350;

// Debounce a rapidly-changing value so each keystroke does not fire a request (Klipy's test key is
// 100 calls/hr — a debounce keeps a burst of typing to a single query).
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

export function GifPicker({ onPick }: { onPick: (gif: GifResult) => void }) {
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query.trim(), DEBOUNCE_MS);

  const search = useInfiniteQuery({
    queryKey: ["gifs", debounced],
    // "" = first page: the `&pos=` is omitted so the provider returns the opening page + a `next` cursor.
    initialPageParam: "",
    queryFn: ({ pageParam }) =>
      apiClient.get(
        `/api/gifs/search?q=${encodeURIComponent(debounced)}${pageParam ? `&pos=${pageParam}` : ""}`,
        GifSearchResponse,
      ),
    getNextPageParam: (lastPage) => lastPage.next ?? undefined,
    staleTime: 60_000,
  });

  const results = search.data?.pages.flatMap((p) => p.results) ?? [];
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = search;

  // A bottom sentinel inside the scroll container drives `fetchNextPage` (mirrors MessageList's top
  // sentinel): root is the scroll viewport, fire on intersect while a page remains and none is inflight.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (el === null || sentinel === null || !hasNextPage) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting !== true) return;
        if (isFetchingNextPage) return;
        void fetchNextPage();
      },
      { root: el, threshold: 0 },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <div data-testid="gif-picker" className="flex h-[360px] w-full flex-col">
      <div className="border-b p-2">
        <Input
          data-testid="gif-search-input"
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={m.chat_gif_search_placeholder()}
          aria-label={m.chat_gif_search_placeholder()}
          className="h-9"
        />
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-2">
        {search.isPending ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Spinner />
          </div>
        ) : search.isError ? (
          <div
            data-testid="gif-error"
            className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground"
          >
            {m.chat_gif_error()}
          </div>
        ) : results.length === 0 ? (
          <div
            data-testid="gif-empty"
            className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground"
          >
            {m.chat_gif_empty()}
          </div>
        ) : (
          <>
            {/* Masonry-ish columns keep varied GIF aspect ratios tidy without per-tile layout math. */}
            <div className="columns-2 gap-2 [&>*]:mb-2">
              {results.map((gif) => (
                <button
                  key={gif.id}
                  type="button"
                  data-testid="gif-result"
                  onClick={() => onPick(gif)}
                  className="block w-full overflow-hidden rounded-md border bg-muted transition hover:ring-2 hover:ring-ring focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  style={{ aspectRatio: `${gif.width} / ${gif.height}` }}
                >
                  <img
                    src={gif.previewUrl}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                </button>
              ))}
            </div>
            {isFetchingNextPage ? (
              <div className="flex justify-center py-2 text-muted-foreground">
                <Spinner />
              </div>
            ) : null}
            <div ref={sentinelRef} data-testid="gif-sentinel" className="h-px w-full" />
          </>
        )}
      </div>
      <div className="border-t px-2 py-1 text-right text-[10px] text-muted-foreground">
        {m.chat_gif_powered()}
      </div>
    </div>
  );
}
