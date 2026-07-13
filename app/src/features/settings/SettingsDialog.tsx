import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { m } from "@/paraglide/messages.js";
import { roomStore } from "@/stores/room";
import { useStore } from "zustand";
import { VoiceSettingsSection } from "@/features/voice/VoiceSettingsSection";
import { AccountSection } from "./AccountSection";
import { AppSection } from "./AppSection";
import { NotificationsSection } from "./NotificationsSection";

// FR-03/04/05/06/07/16 settings surface: a shadcn Dialog (opened from the UserMenu) with the three
// pinned tabs. Each section owns its own save/persist behavior; this component only frames them.
export function SettingsDialog({
  serverId,
  open,
  onOpenChange,
}: {
  serverId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const cost = useStore(roomStore(serverId), (state) => state.cost);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="settings-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{m.settings_title()}</DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="account" data-testid="settings-tabs">
          <TabsList className="w-full">
            <TabsTrigger value="account" data-testid="settings-tab-account">
              {m.settings_tabs_account()}
            </TabsTrigger>
            <TabsTrigger value="app" data-testid="settings-tab-app">
              {m.settings_tabs_app()}
            </TabsTrigger>
            <TabsTrigger value="notifications" data-testid="settings-tab-notifications">
              {m.settings_tabs_notifications()}
            </TabsTrigger>
            <TabsTrigger value="voice" data-testid="settings-tab-voice">
              {m.settings_tabs_voice()}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="account">
            <AccountSection />
          </TabsContent>
          <TabsContent value="app">
            <AppSection cost={cost} />
          </TabsContent>
          <TabsContent value="notifications">
            <NotificationsSection />
          </TabsContent>
          <TabsContent value="voice">
            <VoiceSettingsSection />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
