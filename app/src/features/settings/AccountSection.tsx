import type { ErrorCode, PatchProfileRequest } from "@tavern/shared";
import { ApiErrorBody, LIMITS, USER_COLORS, UserProfile } from "@tavern/shared";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, apiClient } from "@/lib/apiClient";
import { authTransport } from "@/lib/authTransport";
import { errorMessage } from "@/lib/errorMessage";
import { AvatarTooLargeError, resizeToWebp, UnsupportedImageError } from "@/lib/imageResize";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages.js";
import { useSessionStore } from "@/stores/session";

interface ProfileForm {
  displayName: string;
  username: string;
  color: string;
}

// Swatch palette = the shared non-gray USER_COLORS (gray is intentionally not selectable); a free hex
// input covers everything else (validated `/^#[0-9a-f]{6}$/`).
const COLOR_SWATCHES = USER_COLORS;

const API_BASE: string = import.meta.env.VITE_API_URL ?? "";

// Avatar bytes are posted raw (Content-Type image/webp) — not JSON, not multipart — so this uses a
// thin authed fetch mirroring apiClient's transport (auth headers + set-auth-token capture + typed
// ErrorCode on failure) rather than apiClient's JSON body path.
async function postAvatar(blob: Blob): Promise<string> {
  const headers = { ...(await authTransport.getAuthHeaders()), "Content-Type": "image/webp" };
  const res = await fetch(`${API_BASE}/api/me/avatar`, {
    method: "POST",
    headers,
    body: blob,
    credentials: "include",
  });
  await authTransport.storeFromResponse(res.headers);
  if (!res.ok) {
    let code: ErrorCode = "bad_message";
    try {
      const parsed = ApiErrorBody.safeParse(await res.json());
      if (parsed.success) code = parsed.data.error;
    } catch {
      // Non-JSON error body — keep the generic code.
    }
    throw new ApiError(code, res.status);
  }
  const body = (await res.json()) as { avatarKey?: string };
  return body.avatarKey ?? "";
}

// FR-03/FR-04/FR-05 profile editor: displayName, username (lowercased), name color (swatches + hex),
// avatar upload. One Save button persists the DIRTY profile fields via PATCH; the avatar posts on its
// own file-select. Live propagation to other clients arrives server-side as `member.update`.
export function AccountSection() {
  const profile = useSessionStore((s) => s.profile);
  const { register, handleSubmit, setValue, watch, reset, formState } = useForm<ProfileForm>({
    defaultValues: {
      displayName: profile?.displayName ?? "",
      username: profile?.username ?? "",
      color: profile?.color ?? USER_COLORS[0],
    },
  });
  const color = watch("color");
  const usernameField = register("username", { required: true, pattern: LIMITS.usernameRe });
  const colorField = register("color", { required: true, pattern: LIMITS.colorRe });

  const onSubmit = handleSubmit(async (values) => {
    const dirty = formState.dirtyFields;
    const payload: PatchProfileRequest = {};
    if (dirty.displayName) payload.displayName = values.displayName;
    if (dirty.username) payload.username = values.username;
    if (dirty.color) payload.color = values.color;
    try {
      const updated = await apiClient.patch("/api/me/profile", UserProfile, payload);
      useSessionStore.getState().setAuthed(updated);
      reset(values);
      toast(m.common_saved());
    } catch (err) {
      if (err instanceof ApiError) toast(errorMessage(err.code));
    }
  });

  const onAvatarChange = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file === undefined) return;
    try {
      const avatarKey = await postAvatar(await resizeToWebp(file));
      // Reflect the new avatar immediately (header reads profile.avatarKey to decide whether to render
      // the image). The media URL is stable per-user; the served etag changes so the fresh bytes load.
      useSessionStore.getState().patchProfile({ avatarKey });
      toast(m.common_saved());
    } catch (err) {
      if (err instanceof AvatarTooLargeError) toast(m.errors_avatar_too_large());
      else if (err instanceof UnsupportedImageError) toast(errorMessage("unsupported_media"));
      else if (err instanceof ApiError) toast(errorMessage(err.code));
    }
  };

  return (
    <form data-testid="settings-account" onSubmit={onSubmit} className="flex flex-col gap-4 py-2">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="settings-display-name">{m.settings_account_display_name()}</Label>
        <Input
          {...register("displayName", {
            required: true,
            minLength: LIMITS.displayNameMin,
            maxLength: LIMITS.displayNameMax,
          })}
          id="settings-display-name"
          data-testid="input-display-name"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="settings-username">{m.settings_account_username()}</Label>
        <Input
          {...usernameField}
          id="settings-username"
          data-testid="input-username"
          autoCapitalize="none"
          onChange={(event) => {
            event.target.value = event.target.value.toLowerCase();
            void usernameField.onChange(event);
          }}
        />
        {formState.errors.username !== undefined && (
          <p data-testid="error-username" className="text-sm text-destructive">
            {m.error_username_invalid()}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>{m.settings_account_color()}</Label>
        <div className="flex flex-wrap gap-1.5">
          {COLOR_SWATCHES.map((hex) => (
            <button
              key={hex}
              type="button"
              aria-label={hex}
              data-testid={`swatch-${hex}`}
              onClick={() => setValue("color", hex, { shouldDirty: true, shouldValidate: true })}
              style={{ backgroundColor: hex }}
              className={cn(
                "size-6 rounded-full border border-foreground/10",
                color === hex && "ring-2 ring-ring ring-offset-1 ring-offset-background",
              )}
            />
          ))}
        </div>
        <Input
          {...colorField}
          data-testid="input-color"
          className="w-28 font-mono"
          onChange={(event) => {
            event.target.value = event.target.value.toLowerCase();
            void colorField.onChange(event);
          }}
        />
        {formState.errors.color !== undefined && (
          <p data-testid="error-color" className="text-sm text-destructive">
            {m.errors_color_invalid()}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>{m.settings_account_avatar()}</Label>
        <label
          data-testid="avatar-label"
          className={cn(
            "inline-flex w-fit cursor-pointer items-center rounded-lg border border-input px-2.5 py-1 text-sm hover:bg-muted",
          )}
        >
          {m.settings_account_change_avatar()}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            data-testid="avatar-input"
            className="hidden"
            onChange={(event) => void onAvatarChange(event)}
          />
        </label>
      </div>
      <Button type="submit" data-testid="settings-account-save" disabled={!formState.isDirty}>
        {m.common_save()}
      </Button>
    </form>
  );
}
