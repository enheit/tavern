import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useNavigate } from "react-router";
import { CreateServerRequest, JoinServerRequest } from "@tavern/shared";
import { PasswordInput } from "@/components/password-input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "@/lib/apiClient";
import { errorMessage } from "@/lib/errorMessage";
import { m } from "@/paraglide/messages.js";
import { useServers } from "./useServers";

// Route /join (first-run + "join or create" from the switcher). ONE centered Join card (nickname +
// password) — joining is the common path since the app lands the user on their first server anyway.
// Creating a server is deliberately low-key: a muted link under the card opens a dialog asking for
// nickname, password (ALWAYS required) and the one-time operator-issued creation code (FR-08
// hardening). Both forms use RHF over the shared schemas; a server ErrorCode renders in the form's
// error slot via errorMessage() (the S4.3 resolver — no dynamic key construction, §9.6).
export function JoinOrCreatePage() {
  return (
    <div
      data-testid="page-join"
      className="flex h-full w-full items-center justify-center overflow-auto p-4"
    >
      <div className="flex w-full max-w-sm flex-col items-center gap-2">
        <JoinCard />
        <CreateServerDialog />
      </div>
    </div>
  );
}

// Empty password → undefined (open server / "no password") so the shared schema treats it as absent.
const emptyToUndefined = (value: string): string | undefined => (value === "" ? undefined : value);

function JoinCard() {
  const navigate = useNavigate();
  const { joinServer, pending, error } = useServers();
  const [networkError, setNetworkError] = useState(false);
  const form = useForm<JoinServerRequest>({
    resolver: zodResolver(JoinServerRequest),
    defaultValues: { nickname: "" },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setNetworkError(false);
    try {
      navigate(`/s/${await joinServer(values)}`);
    } catch (err) {
      if (!(err instanceof ApiError)) setNetworkError(true);
    }
  });
  const formError = error !== null ? errorMessage(error) : networkError ? m.error_network() : null;

  return (
    <Card data-testid="join-card" className="w-full">
      <CardHeader>
        <CardTitle>{m.servers_join_title()}</CardTitle>
      </CardHeader>
      <CardContent>
        <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="join-nickname">{m.servers_join_nickname()}</Label>
            <Input
              {...form.register("nickname")}
              id="join-nickname"
              data-testid="join-nickname"
              autoComplete="off"
              autoCapitalize="none"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="join-password">{m.servers_join_password()}</Label>
            <PasswordInput
              {...form.register("password", { setValueAs: emptyToUndefined })}
              id="join-password"
              data-testid="join-password"
              autoComplete="off"
            />
          </div>
          {formError !== null && (
            <p role="alert" data-testid="join-error" className="text-sm text-destructive">
              {formError}
            </p>
          )}
          <Button type="submit" disabled={pending} data-testid="join-submit">
            {m.servers_join_submit()}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// The low-key "Create my own server" entry: a muted link-style button under the Join card opening
// the create dialog. The dialog's form resets on close so a reopened dialog never shows stale
// values or a stale server error. Client-side zod issues map to ONE static message per field (§9.6):
// nickname → error_nickname_invalid, password → servers_create_password_short, code →
// servers_create_code_required. Server ErrorCodes (nickname_taken, invalid_code, …) render in the
// form-level slot.
function CreateServerDialog() {
  const navigate = useNavigate();
  const { createServer, pending, error } = useServers();
  const [open, setOpen] = useState(false);
  const [networkError, setNetworkError] = useState(false);
  const form = useForm<CreateServerRequest>({
    resolver: zodResolver(CreateServerRequest),
    defaultValues: { nickname: "", password: "", code: "" },
  });
  const errors = form.formState.errors;

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      form.reset();
      setNetworkError(false);
    }
  };

  const onSubmit = form.handleSubmit(async (values) => {
    setNetworkError(false);
    try {
      navigate(`/s/${await createServer(values)}`);
    } catch (err) {
      if (!(err instanceof ApiError)) setNetworkError(true);
    }
  });
  const formError = error !== null ? errorMessage(error) : networkError ? m.error_network() : null;

  return (
    <>
      <Button
        variant="link"
        data-testid="create-open"
        className="text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(true)}
      >
        {m.servers_create_open()}
      </Button>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent data-testid="create-dialog">
          <DialogHeader>
            <DialogTitle>{m.servers_create_title()}</DialogTitle>
            <DialogDescription>{m.servers_create_description()}</DialogDescription>
          </DialogHeader>
          <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="create-nickname">{m.servers_join_nickname()}</Label>
              <Input
                {...form.register("nickname")}
                id="create-nickname"
                data-testid="create-nickname"
                autoComplete="off"
                autoCapitalize="none"
              />
              {errors.nickname !== undefined && (
                <p
                  role="alert"
                  data-testid="create-nickname-error"
                  className="text-sm text-destructive"
                >
                  {m.error_nickname_invalid()}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="create-password">{m.servers_create_password()}</Label>
              <PasswordInput
                {...form.register("password")}
                id="create-password"
                data-testid="create-password"
                autoComplete="off"
              />
              {errors.password !== undefined && (
                <p
                  role="alert"
                  data-testid="create-password-error"
                  className="text-sm text-destructive"
                >
                  {m.servers_create_password_short()}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="create-code">{m.servers_create_code()}</Label>
              <Input
                {...form.register("code")}
                id="create-code"
                data-testid="create-code"
                autoComplete="off"
                autoCapitalize="none"
              />
              {errors.code !== undefined && (
                <p
                  role="alert"
                  data-testid="create-code-error"
                  className="text-sm text-destructive"
                >
                  {m.servers_create_code_required()}
                </p>
              )}
            </div>
            {formError !== null && (
              <p role="alert" data-testid="create-error" className="text-sm text-destructive">
                {formError}
              </p>
            )}
            <Button type="submit" disabled={pending} data-testid="create-submit">
              {m.servers_create_submit()}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
