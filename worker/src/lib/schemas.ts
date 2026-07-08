import { z } from 'zod';

// §1 "Validation limits". Lengths are counted in Unicode code points.
// nickname is ASCII-only (regex), so code points == code units there; password
// allows any chars, so it is counted by spreading into code points.
const codePoints = (s: string) => [...s].length;

export const nickname = z
  .string()
  .regex(/^[A-Za-z0-9_]{2,32}$/, 'nickname must be 2–32 of A–Z a–z 0–9 _');

export const password = z
  .string()
  .refine((s) => codePoints(s) >= 8 && codePoints(s) <= 128, 'password must be 8–128 characters');

export const registerSchema = z
  .object({ nickname, password, repeat: z.string() })
  .refine((d) => d.password === d.repeat, { message: 'passwords do not match', path: ['repeat'] });

// Login does not re-validate format — a badly-shaped nickname/password simply
// fails the lookup/verify and returns 401 (no user enumeration via 400 vs 401).
export const loginSchema = z.object({ nickname: z.string(), password: z.string() });

// Server / channel name: trimmed, 1–48 code points after trim (§1).
export const entityName = z
  .string()
  .transform((s) => s.trim())
  .refine((s) => codePoints(s) >= 1 && codePoints(s) <= 48, 'name must be 1–48 characters');

export const channelKind = z.enum(['text', 'voice']);

export const createServerSchema = z.object({ name: entityName, password: password.optional() });
export const joinServerSchema = z.object({ serverId: z.string(), password: z.string().optional() });
export const createChannelSchema = z.object({
  name: entityName,
  kind: channelKind,
  password: password.optional(),
});
export const unlockSchema = z.object({ password: z.string() });
