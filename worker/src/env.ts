// Named local environments can intentionally omit production-only credentials. Validate secrets at
// the boundary that actually uses them so mock mode stays credential-free and production fails with
// a clear configuration error instead of sending an invalid upstream request.
export function requiredEnv(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required environment binding: ${name}`);
  }
  return value;
}
