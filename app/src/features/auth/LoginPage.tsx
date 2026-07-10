import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Link } from "react-router";
import { LoginForm } from "@tavern/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/errorMessage";
import { m } from "@/paraglide/messages.js";
import { useAuth } from "./useAuth";

// FR-02 login. Client-side schema is the shared `LoginForm` (no format rules — the server owns
// credential checks and returns a generic `invalid_credentials` so wrong username vs wrong password
// are indistinguishable). The username input is normalized to lowercase on change (§App-B usernames
// are stored lowercase).
export function LoginPage() {
  const { login, pending, error } = useAuth();
  const [networkError, setNetworkError] = useState(false);
  const form = useForm<LoginForm>({
    resolver: zodResolver(LoginForm),
    defaultValues: { username: "", password: "" },
  });
  const usernameField = form.register("username");

  const onSubmit = form.handleSubmit(async (values) => {
    setNetworkError(false);
    try {
      await login(values);
    } catch {
      setNetworkError(true);
    }
  });

  const formError = error !== null ? errorMessage(error) : networkError ? m.error_network() : null;

  return (
    <div data-testid="page-login" className="flex h-full w-full items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{m.auth_login_title()}</CardTitle>
        </CardHeader>
        <CardContent>
          <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="login-username">{m.auth_login_username()}</Label>
              <Input
                {...usernameField}
                id="login-username"
                data-testid="input-username"
                autoComplete="username"
                autoCapitalize="none"
                onChange={(event) => {
                  event.target.value = event.target.value.toLowerCase();
                  void usernameField.onChange(event);
                }}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="login-password">{m.auth_login_password()}</Label>
              <Input
                {...form.register("password")}
                id="login-password"
                data-testid="input-password"
                type="password"
                autoComplete="current-password"
              />
            </div>
            {formError !== null && (
              <p role="alert" data-testid="form-error" className="text-sm text-destructive">
                {formError}
              </p>
            )}
            <Button type="submit" disabled={pending} data-testid="submit">
              {m.auth_login_submit()}
            </Button>
          </form>
        </CardContent>
        <CardFooter className="justify-center gap-1 text-sm text-muted-foreground">
          <span>{m.auth_login_no_account()}</span>
          <Link
            to="/register"
            data-testid="link-register"
            className="text-primary underline-offset-4 hover:underline"
          >
            {m.auth_login_register_link()}
          </Link>
        </CardFooter>
      </Card>
    </div>
  );
}
