import { z } from "zod";

// The 32 ErrorCodes shared by API/WS/UI i18n (PLAN §App-A + step S0.2; +invalid_code for the
// one-time server-creation codes).
export const ERROR_CODES = [
  "bad_message",
  "bad_request",
  "invalid_ticket",
  "unauthorized",
  "forbidden",
  "not_found",
  "not_member",
  "not_admin",
  "not_in_voice",
  "not_implemented",
  "voice_elsewhere",
  "share_cap",
  "cost_cap",
  "pull_denied",
  "already_recording",
  "rate_limited",
  "rtc_rate_limited",
  "invalid_credentials",
  "username_taken",
  "nickname_taken",
  "wrong_password",
  "invalid_code",
  "password_mismatch",
  "password_too_short",
  "server_cap",
  "server_full",
  "payload_too_large",
  "unsupported_media",
  "sound_too_long",
  "bad_trim",
  "bad_part_size",
  "recording_too_long",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const errorCodeSchema = z.enum(ERROR_CODES);
