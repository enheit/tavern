import type { ErrorCode } from "@tavern/shared";
import { m } from "@/paraglide/messages.js";

// The ONLY code→message resolver (§9.6). Feature steps call errorMessage(code) for server-error
// slots — never construct message keys dynamically. The Record is EXHAUSTIVE over ErrorCode, so a
// missing or extra code fails to typecheck; each entry maps to its static `m.error_<code>()`.
const RESOLVERS: Record<ErrorCode, () => string> = {
  bad_message: () => m.error_bad_message(),
  bad_request: () => m.error_bad_request(),
  invalid_ticket: () => m.error_invalid_ticket(),
  unauthorized: () => m.error_unauthorized(),
  forbidden: () => m.error_forbidden(),
  not_found: () => m.error_not_found(),
  not_member: () => m.error_not_member(),
  not_admin: () => m.error_not_admin(),
  not_in_voice: () => m.error_not_in_voice(),
  not_implemented: () => m.error_not_implemented(),
  voice_elsewhere: () => m.error_voice_elsewhere(),
  share_cap: () => m.error_share_cap(),
  cost_cap: () => m.error_cost_cap(),
  pull_denied: () => m.error_pull_denied(),
  already_recording: () => m.error_already_recording(),
  rate_limited: () => m.error_rate_limited(),
  rtc_rate_limited: () => m.error_rtc_rate_limited(),
  invalid_credentials: () => m.error_invalid_credentials(),
  username_taken: () => m.error_username_taken(),
  nickname_taken: () => m.error_nickname_taken(),
  wrong_password: () => m.error_wrong_password(),
  invalid_code: () => m.error_invalid_code(),
  password_mismatch: () => m.error_password_mismatch(),
  password_too_short: () => m.error_password_too_short(),
  server_cap: () => m.error_server_cap(),
  server_full: () => m.error_server_full(),
  payload_too_large: () => m.error_payload_too_large(),
  unsupported_media: () => m.error_unsupported_media(),
  sound_too_long: () => m.error_sound_too_long(),
  bad_trim: () => m.error_bad_trim(),
  bad_part_size: () => m.error_bad_part_size(),
  recording_too_long: () => m.error_recording_too_long(),
  poll_closed: () => m.error_poll_closed(),
  poll_limit: () => m.error_poll_limit(),
  already_bid: () => m.error_already_bid(),
  insufficient_points: () => m.error_insufficient_points(),
  correction_expired: () => m.error_correction_expired(),
  correction_used: () => m.error_correction_used(),
};

export function errorMessage(code: ErrorCode): string {
  return RESOLVERS[code]();
}
