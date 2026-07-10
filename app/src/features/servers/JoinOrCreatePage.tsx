import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useNavigate } from "react-router";
import { CreateServerRequest, JoinServerRequest } from "@tavern/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "@/lib/apiClient";
import { errorMessage } from "@/lib/errorMessage";
import { m } from "@/paraglide/messages.js";
import { useServers } from "./useServers";

// Route /join (first-run + "join or create" from the switcher). Two cards side by side: Join (nickname +
// optional password, always visible) and Create (nickname + optional password). Both use RHF over the
// shared schemas. A server ErrorCode renders in the card's form-level slot via errorMessage() (the S4.3
// resolver — no dynamic key construction, §9.6).
export function JoinOrCreatePage() {
  return (
    <div
      data-testid="page-join"
      className="flex h-full w-full items-center justify-center overflow-auto p-4"
    >
      <div className="grid w-full max-w-3xl gap-4 md:grid-cols-2">
        <JoinCard />
        <CreateCard />
      </div>
    </div>
  );
}

// Empty password → undefined (open server / "no password") so the shared schemas treat it as absent.
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
    <Card data-testid="join-card">
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
            <Input
              {...form.register("password", { setValueAs: emptyToUndefined })}
              id="join-password"
              data-testid="join-password"
              type="password"
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

function CreateCard() {
  const navigate = useNavigate();
  const { createServer, pending, error } = useServers();
  const [networkError, setNetworkError] = useState(false);
  const form = useForm<CreateServerRequest>({
    resolver: zodResolver(CreateServerRequest),
    defaultValues: { nickname: "" },
  });

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
    <Card data-testid="create-card">
      <CardHeader>
        <CardTitle>{m.servers_create_title()}</CardTitle>
      </CardHeader>
      <CardContent>
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
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-password">{m.servers_create_password()}</Label>
            <Input
              {...form.register("password", { setValueAs: emptyToUndefined })}
              id="create-password"
              data-testid="create-password"
              type="password"
              autoComplete="off"
            />
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
      </CardContent>
    </Card>
  );
}
