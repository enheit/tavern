import type { PatchServerRequest, PointConfig } from "@tavern/shared";
import {
  LIMITS,
  PatchServerRequest as PatchServerSchema,
  PointConfig as PointConfigSchema,
  ServerSummary,
} from "@tavern/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import { Settings2Icon } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { useStore } from "zustand";
import { PasswordInput } from "@/components/password-input";
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
import { Switch } from "@/components/ui/switch";
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
      <DialogContent
        data-testid="admin-dialog"
        className="max-h-[85vh] overflow-y-auto sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>{m.admin_title()}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-6 py-1">
          <RenameSection serverId={serverId} />
          <PasswordSection serverId={serverId} />
          <PointsSection serverId={serverId} />
          <MembersSection serverId={serverId} selfId={selfId} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RateField({
  id,
  label,
  value,
  update,
}: {
  id: string;
  label: string;
  value: number;
  update: (value: number) => void;
}) {
  return (
    <Label htmlFor={id} className="grid grid-cols-[1fr_7rem] items-center gap-3 text-xs">
      <span>{label}</span>
      <Input
        id={id}
        data-testid={id}
        type="number"
        min={0}
        max={LIMITS.pointRateMaxPerMinute}
        value={value}
        onChange={(event) => update(Number(event.target.value))}
      />
    </Label>
  );
}

function PointsSection({ serverId }: { serverId: string }) {
  const current = useStore(roomStore(serverId), (state) => state.points.config);
  const [draft, setDraft] = useState<PointConfig>(current);
  const [dailyCap, setDailyCap] = useState(current.dailyCap?.toString() ?? "");

  const save = async (): Promise<void> => {
    const parsed = PointConfigSchema.safeParse({
      ...draft,
      dailyCap: dailyCap.trim() === "" ? null : Number(dailyCap),
    });
    if (!parsed.success) return;
    try {
      const saved = await apiClient.put(
        `/api/servers/${serverId}/points/config`,
        PointConfigSchema,
        parsed.data,
      );
      setDraft(saved);
      setDailyCap(saved.dailyCap?.toString() ?? "");
      toast(m.admin_points_saved());
    } catch (err) {
      if (err instanceof ApiError) toast(errorMessage(err.code));
    }
  };

  return (
    <section data-testid="admin-points" className="flex flex-col gap-3 border-t pt-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium">{m.admin_points_title()}</h3>
          <p className="text-xs text-muted-foreground">{m.admin_points_hint()}</p>
        </div>
        <Switch
          data-testid="admin-points-enabled"
          checked={draft.enabled}
          onCheckedChange={(enabled) => setDraft((value) => ({ ...value, enabled }))}
        />
      </div>
      <RateField
        id="admin-points-base"
        label={m.admin_points_base()}
        value={draft.basePointsPerMinute}
        update={(basePointsPerMinute) =>
          setDraft((value) => ({ ...value, basePointsPerMinute }))
        }
      />
      <RateField
        id="admin-points-stream"
        label={m.admin_points_stream()}
        value={draft.streamerBonusPerMinute}
        update={(streamerBonusPerMinute) =>
          setDraft((value) => ({ ...value, streamerBonusPerMinute }))
        }
      />
      <RateField
        id="admin-points-watch"
        label={m.admin_points_watch()}
        value={draft.watcherBonusPerMinute}
        update={(watcherBonusPerMinute) =>
          setDraft((value) => ({ ...value, watcherBonusPerMinute }))
        }
      />
      <Label
        htmlFor="admin-points-cap"
        className="grid grid-cols-[1fr_7rem] items-center gap-3 text-xs"
      >
        <span>{m.admin_points_cap()}</span>
        <Input
          id="admin-points-cap"
          data-testid="admin-points-cap"
          type="number"
          min={1}
          max={LIMITS.pointDailyCapMax}
          placeholder={m.admin_points_no_cap()}
          value={dailyCap}
          onChange={(event) => setDailyCap(event.target.value)}
        />
      </Label>
      <Button
        type="button"
        data-testid="admin-points-save"
        onClick={() => void save()}
        disabled={
          !PointConfigSchema.safeParse({
            ...draft,
            dailyCap: dailyCap.trim() === "" ? null : Number(dailyCap),
          }).success
        }
      >
        {m.common_save()}
      </Button>
    </section>
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

// FR-10 password: replace only — a server password is always set, so there is no "clear" flow.
// The current password is never shown — the server never returns it.
function PasswordSection({ serverId }: { serverId: string }) {
  const [password, setPassword] = useState("");

  const submit = async (value: string): Promise<void> => {
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
        <PasswordInput
          id="admin-password-input"
          data-testid="admin-password-input"
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
