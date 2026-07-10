import type { Page } from "@playwright/test";

// The FR-43 boot sequence (boot-loader → a single page-*) is transient — the loader is unmounted the
// instant the target page attaches, so polling for it live is racy. Instead we install a
// MutationObserver BEFORE the page's own scripts run (page.addInitScript applies to the next
// load/reload) that records every boot-loader / page-* test id in attach order, letting a spec assert
// both the loader appeared and that the ONLY page-* ever attached is the expected one (the no-flash
// guard).

declare global {
  interface Window {
    tavernBootTestIds?: string[];
  }
}

export async function recordTestIds(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    window.tavernBootTestIds = seen;
    const consider = (element: Element) => {
      const id = element.getAttribute("data-testid");
      if (id !== null && (id === "boot-loader" || id.startsWith("page-"))) seen.push(id);
    };
    const scan = (node: Node) => {
      if (node instanceof Element) {
        consider(node);
        for (const el of node.querySelectorAll("[data-testid]")) consider(el);
      }
    };
    const observer = new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) scan(node);
    });
    observer.observe(document, { childList: true, subtree: true });
  });
}

export async function readTestIds(page: Page): Promise<string[]> {
  return page.evaluate(() => window.tavernBootTestIds ?? []);
}

// The distinct page-* ids seen, in first-attach order — the input to the no-flash assertion.
export function uniquePageIds(seen: string[]): string[] {
  return [...new Set(seen.filter((id) => id.startsWith("page-")))];
}
