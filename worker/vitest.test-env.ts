// Public test fixtures only. Keep every network-bound integration disabled while satisfying the
// Wrangler config's declared binding shape; production values are injected separately as secrets.
export const TEST_SECRETS = {
  BETTER_AUTH_SECRET: "test-only-auth-secret-00000000000000000000000000000000",
  REALTIME_APP_ID: "",
  REALTIME_APP_SECRET: "",
  TURN_KEY_ID: "",
  TURN_KEY_API_TOKEN: "",
  CLOUDFLARE_ANALYTICS_TOKEN: "",
  KLIPY_API_KEY: "",
} satisfies Record<string, string>;
