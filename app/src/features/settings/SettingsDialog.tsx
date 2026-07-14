import { LogOutIcon } from "lucide-react";
import { useStore } from "zustand";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/features/auth/useAuth";
import { m } from "@/paraglide/messages.js";
import { roomStore } from "@/stores/room";
import { VoiceSettingsSection } from "@/features/voice/VoiceSettingsSection";
import { AppSection } from "./AppSection";
import { NotificationsSection } from "./NotificationsSection";
import { TavernUsageSection } from "./TavernUsageSection";

const SIDEBAR_TAB_CLASS =
  "h-auto px-3 py-2 hover:bg-muted/50 data-active:bg-muted dark:data-active:bg-muted";

// Application settings deliberately have two independent scroll regions: the navigation can grow
// without hiding Log out, while long content such as usage data scrolls without moving the selection.
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
  const { logout, pending } = useAuth();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="settings-dialog"
        className="h-[min(85vh,44rem)] max-h-[calc(100vh-2rem)] grid-rows-[minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-4xl"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{m.settings_title()}</DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="app" orientation="vertical" className="h-full min-h-0 gap-0">
          <aside className="flex min-h-0 w-48 shrink-0 flex-col border-r bg-muted/30">
            <ScrollArea data-testid="settings-sidebar-scroll" className="min-h-0 flex-1">
              <TabsList className="w-full items-stretch gap-1 rounded-none bg-transparent p-2">
                <TabsTrigger
                  value="app"
                  data-testid="settings-tab-app"
                  className={SIDEBAR_TAB_CLASS}
                >
                  {m.settings_tabs_app()}
                </TabsTrigger>
                <TabsTrigger
                  value="notifications"
                  data-testid="settings-tab-notifications"
                  className={SIDEBAR_TAB_CLASS}
                >
                  {m.settings_tabs_notifications()}
                </TabsTrigger>
                <TabsTrigger
                  value="voice"
                  data-testid="settings-tab-voice"
                  className={SIDEBAR_TAB_CLASS}
                >
                  {m.settings_tabs_voice()}
                </TabsTrigger>
                <TabsTrigger
                  value="tavern-usage"
                  data-testid="settings-tab-tavern-usage"
                  className={SIDEBAR_TAB_CLASS}
                >
                  {m.settings_tabs_tavern_usage()}
                </TabsTrigger>
              </TabsList>
            </ScrollArea>
            <div className="border-t p-2">
              <Button
                variant="ghost"
                data-testid="settings-logout"
                disabled={pending}
                className="w-full justify-start text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => void logout()}
              >
                <LogOutIcon />
                {m.shell_user_menu_logout()}
              </Button>
            </div>
          </aside>
          <ScrollArea data-testid="settings-content-scroll" className="min-h-0 flex-1">
            <div className="mx-auto w-full max-w-2xl p-6 pr-8">
              <TabsContent value="app">
                <h2 className="text-xl font-semibold tracking-tight">{m.settings_tabs_app()}</h2>
                <AppSection />
              </TabsContent>
              <TabsContent value="notifications">
                <h2 className="text-xl font-semibold tracking-tight">
                  {m.settings_tabs_notifications()}
                </h2>
                <NotificationsSection />
              </TabsContent>
              <TabsContent value="voice">
                <h2 className="text-xl font-semibold tracking-tight">{m.settings_tabs_voice()}</h2>
                <VoiceSettingsSection />
              </TabsContent>
              <TabsContent value="tavern-usage">
                <h2 className="text-xl font-semibold tracking-tight">
                  {m.settings_tabs_tavern_usage()}
                </h2>
                <TavernUsageSection cost={cost} />
              </TabsContent>
            </div>
          </ScrollArea>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
