import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Link } from "react-router";
import { RegisterForm } from "@tavern/shared";
import { PasswordInput } from "@/components/password-input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/errorMessage";
import { m } from "@/paraglide/messages.js";
import { useAuth } from "./useAuth";

// FR-01 register. Uses the shared `RegisterForm` schema verbatim (never redeclared). Its client-side
// zod issues are machine codes; each field maps to ONE static message (§9.6 — no dynamic keys):
// username → error_username_invalid, password → error_password_too_short, repeat → error_password_mismatch.
// Server `ErrorCode`s (e.g. username_taken) render in the form-level slot via errorMessage().
export function RegisterPage() {
  const { register: submitRegister, pending, error } = useAuth();
  const [networkError, setNetworkError] = useState(false);
  const form = useForm<RegisterForm>({
    resolver: zodResolver(RegisterForm),
    defaultValues: { username: "", password: "", repeatPassword: "" },
  });
  const errors = form.formState.errors;
  const usernameField = form.register("username");

  const onSubmit = form.handleSubmit(async (values) => {
    setNetworkError(false);
    try {
      await submitRegister(values);
    } catch {
      setNetworkError(true);
    }
  });

  const formError = error !== null ? errorMessage(error) : networkError ? m.error_network() : null;

  return (
    <div data-testid="page-register" className="flex h-full w-full items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{m.auth_register_title()}</CardTitle>
        </CardHeader>
        <CardContent>
          <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="register-username">{m.auth_login_username()}</Label>
              <Input
                {...usernameField}
                id="register-username"
                data-testid="input-username"
                autoComplete="username"
                autoCapitalize="none"
                onChange={(event) => {
                  event.target.value = event.target.value.toLowerCase();
                  void usernameField.onChange(event);
                }}
              />
              {errors.username !== undefined && (
                <p data-testid="error-username" className="text-sm text-destructive">
                  {m.error_username_invalid()}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="register-password">{m.auth_login_password()}</Label>
              <PasswordInput
                {...form.register("password")}
                id="register-password"
                data-testid="input-password"
                autoComplete="new-password"
              />
              {errors.password !== undefined && (
                <p data-testid="error-password" className="text-sm text-destructive">
                  {m.error_password_too_short()}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="register-repeat-password">{m.auth_register_repeat_password()}</Label>
              <PasswordInput
                {...form.register("repeatPassword")}
                id="register-repeat-password"
                data-testid="input-repeat-password"
                autoComplete="new-password"
              />
              {errors.repeatPassword !== undefined && (
                <p data-testid="error-repeat-password" className="text-sm text-destructive">
                  {m.error_password_mismatch()}
                </p>
              )}
            </div>
            {formError !== null && (
              <p role="alert" data-testid="form-error" className="text-sm text-destructive">
                {formError}
              </p>
            )}
            <Button type="submit" disabled={pending} data-testid="submit">
              {m.auth_register_submit()}
            </Button>
          </form>
        </CardContent>
        <CardFooter className="justify-center gap-1 text-sm text-muted-foreground">
          <span>{m.auth_register_have_account()}</span>
          <Link
            to="/login"
            data-testid="link-login"
            className="text-primary underline-offset-4 hover:underline"
          >
            {m.auth_register_login_link()}
          </Link>
        </CardFooter>
      </Card>
    </div>
  );
}
