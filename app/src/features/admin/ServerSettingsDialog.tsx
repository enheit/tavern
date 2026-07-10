import type { PatchServerRequest } from "@tavern/shared";
import { LIMITS, PatchServerRequest as PatchServerSchema, ServerSummary } from "@tavern/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import { Settings2Icon } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
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
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, apiClient } from "@/lib/apiClient";
import { errorMessage } from "@/lib/errorMessage";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages.js";
import { roomStore } from "@/stores/room";
import { useSessionStore } from "@/stores/session";
import { useKickMember } from "./useKickMember";

// FR-10/11/12 admin surface. Renders a gear button + settings dialog ONLY for the server admin
// (self.userId === serverMeta.adminUserId from hello.ok). Header mounts it for the active server;
// non-admins get nothing.
export function ServerSettingsDialog({ serverId }: { serverId: string }) {
  const adminUserId = useStore(roomStore(serverId), (s) => s.serverMeta?.adminUserId ?? null);
  const selfId = useSessionStore((s) => s.profile?.userId ?? null);
  const [open, setOpen] = useState(false);
  if (selfId === null || adminUserId === null || selfId !== adminUserId) return null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        data-testid="admin-settings-button"
        aria-label={m.admin_title()}
        className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }))}
      >
        <Settings2Icon />
      </DialogTrigger>
      <DialogContent data-testid="admin-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{m.admin_title()}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-6 py-1">
          <RenameSection serverId={serverId} />
          <PasswordSection serverId={serverId} />
          <MembersSection serverId={serverId} selfId={selfId} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

// FR-12 rename: RHF over the shared PatchServerRequest schema (serverNickname rule imported, never
// restated). Invalid nickname is blocked client-side by the resolver; `nickname_taken` becomes an
// inline field error; success toasts (the live list/serverMeta update arrives via `server.updated`).
function RenameSection({ serverId }: { serverId: string }) {
  const current = useStore(roomStore(serverId), (s) => s.serverMeta?.nickname ?? "");
  const [taken, setTaken] = useState(false);
  const form = useForm<PatchServerRequest>({
    resolver: zodResolver(PatchServerSchema),
    defaultValues: { nickname: current },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    if (typeof values.nickname !== "string") return;
    setTaken(false);
    try {
      await apiClient.patch(`/api/servers/${serverId}`, ServerSummary, {
        nickname: values.nickname,
      });
      toast(m.admin_renamed());
    } catch (err) {
      if (err instanceof ApiError && err.code === "nickname_taken") setTaken(true);
      else if (err instanceof ApiError) toast(errorMessage(err.code));
    }
  });

  return (
    <section data-testid="admin-rename" className="flex flex-col gap-2">
      <form noValidate onSubmit={onSubmit} className="flex flex-col gap-2">
        <Label htmlFor="admin-nickname">{m.admin_rename_label()}</Label>
        <div className="flex items-center gap-2">
          <Input
            {...form.register("nickname")}
            id="admin-nickname"
            data-testid="admin-nickname-input"
            autoCapitalize="none"
            autoComplete="off"
          />
          <Button type="submit" data-testid="admin-rename-submit">
            {m.common_save()}
          </Button>
        </div>
        {taken && (
          <p data-testid="admin-nickname-error" className="text-sm text-destructive">
            {m.admin_nickname_taken()}
          </p>
        )}
      </form>
    </section>
  );
}

// FR-10 password: set (min-length gated) or clear (confirm alert-dialog → PATCH { password: null }).
// The current password is never shown — the server never returns it.
function PasswordSection({ serverId }: { serverId: string }) {
  const [password, setPassword] = useState("");

  const submit = async (value: string | null): Promise<void> => {
    try {
      await apiClient.patch(`/api/servers/${serverId}`, ServerSummary, { password: value });
      setPassword("");
      toast(m.admin_password_updated());
    } catch (err) {
      if (err instanceof ApiError) toast(errorMessage(err.code));
    }
  };

  return (
    <section data-testid="admin-password" className="flex flex-col gap-2">
      <Label htmlFor="admin-password-input">{m.admin_password_label()}</Label>
      <div className="flex items-center gap-2">
        <Input
          id="admin-password-input"
          data-testid="admin-password-input"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <Button
          type="button"
          data-testid="admin-password-set"
          disabled={password.length < LIMITS.serverPasswordMinLen}
          onClick={() => void submit(password)}
        >
          {m.admin_password_set()}
        </Button>
      </div>
      <AlertDialog>
        <AlertDialogTrigger
          data-testid="admin-password-clear"
          className={cn(buttonVariants({ variant: "outline", size: "sm" }), "w-fit")}
        >
          {m.admin_password_clear()}
        </AlertDialogTrigger>
        <AlertDialogContent data-testid="admin-password-clear-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{m.admin_password_clear()}</AlertDialogTitle>
            <AlertDialogDescription>{m.admin_password_clear_confirm()}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="admin-password-clear-cancel">
              {m.common_cancel()}
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="admin-password-clear-action"
              onClick={() => void submit(null)}
            >
              {m.common_confirm()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

// FR-11 members: each non-self row gets a Kick button opening the shared confirm flow (useKickMember).
function MembersSection({ serverId, selfId }: { serverId: string; selfId: string }) {
  const members = useStore(roomStore(serverId), (s) => s.members);
  const kick = useKickMember(serverId);
  return (
    <section data-testid="admin-members" className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{m.admin_members_title()}</h3>
      <ul className="flex flex-col gap-1">
        {members.map((mem) => (
          <li
            key={mem.userId}
            data-testid={`admin-member-${mem.userId}`}
            className="flex items-center gap-2"
          >
            <span className="truncate text-sm" style={{ color: mem.color }}>
              {mem.displayName}
            </span>
            {mem.userId !== selfId && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid={`admin-kick-${mem.userId}`}
                className="ml-auto text-destructive"
                onClick={() => kick.confirmAndKick(mem.userId)}
              >
                {m.admin_kick()}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {kick.dialog}
    </section>
  );
}
