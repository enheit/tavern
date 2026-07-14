import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { m } from "@/paraglide/messages.js";
import { AccountSection } from "./AccountSection";
import { MarketIconPicker } from "@/features/market/MarketIconPicker";

export function AccountSettingsDialog({
  open,
  onOpenChange,
  serverId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverId: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="account-settings-dialog"
        className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle>{m.settings_tabs_account()}</DialogTitle>
        </DialogHeader>
        <AccountSection onSaved={() => onOpenChange(false)} />
        <div className="border-t pt-4">
          <h3 className="mb-3 font-semibold">{m.market_my_icons()}</h3>
          <MarketIconPicker serverId={serverId} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
