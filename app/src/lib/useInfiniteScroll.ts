import { useEffect } from "react";
import type { RefObject } from "react";

// Loads another page when the list's bottom edge enters its own scroll viewport. Keeping the observer
// rooted to the viewport prevents a long workspace tab from growing the app shell or using page scroll.
export function useInfiniteScroll({
  scrollRef,
  sentinelRef,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  sentinelRef: RefObject<HTMLElement | null>;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => Promise<unknown>;
}): void {
  useEffect(() => {
    const root = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (root === null || sentinel === null || !hasNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting === true && !isFetchingNextPage) void fetchNextPage();
      },
      { root, threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, scrollRef, sentinelRef]);
}
