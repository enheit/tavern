import type { CostStatus } from "@tavern/shared";
import { CloudflareUsage } from "./CloudflareUsage";
import { EgressUsage } from "./EgressUsage";

export function TavernUsageSection({ cost }: { cost: CostStatus | null }) {
  return (
    <div data-testid="settings-tavern-usage" className="flex flex-col gap-5 py-2">
      <EgressUsage cost={cost} />
      <CloudflareUsage />
    </div>
  );
}
