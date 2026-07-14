import type { ErrorCode } from "@tavern/shared";
import { ApiErrorBody } from "@tavern/shared";
import { authTransport } from "./authTransport";

// A9/§9.8 — every REST boundary is zod-validated. Success bodies parse with the caller's schema;
// non-2xx bodies parse into a typed ErrorCode (§9.5). Same-origin `fetch` wrapper. The schema is
// typed structurally (zod is not a direct app dependency) — every shared zod schema satisfies it.
interface Parser<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false };
}

const baseUrl: string = import.meta.env.VITE_API_URL ?? "";

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  constructor(code: ErrorCode, status: number) {
    super(code);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

async function throwApiError(res: Response): Promise<never> {
  let code: ErrorCode = "bad_message";
  try {
    const body: unknown = await res.json();
    const parsed = ApiErrorBody.safeParse(body);
    if (parsed.success) code = parsed.data.error;
  } catch {
    // Non-JSON error body — fall back to the generic code.
  }
  throw new ApiError(code, res.status);
}

interface RequestInit_ {
  method: string;
  path: string;
  body?: unknown;
  form?: FormData;
}

async function request<T>(schema: Parser<T>, opts: RequestInit_): Promise<T> {
  const headers: Record<string, string> = { ...(await authTransport.getAuthHeaders()) };
  let payload: BodyInit | null = null;
  if (opts.form) {
    payload = opts.form; // let the browser set the multipart boundary
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(opts.body);
  }
  const res = await fetch(`${baseUrl}${opts.path}`, {
    method: opts.method,
    headers,
    body: payload,
    credentials: "include",
  });
  await authTransport.storeFromResponse(res.headers);
  if (!res.ok) return throwApiError(res);
  const json: unknown = await res.json();
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ApiError("bad_message", res.status);
  return parsed.data;
}

export const apiClient = {
  get: <T>(path: string, schema: Parser<T>) => request(schema, { method: "GET", path }),
  post: <T>(path: string, schema: Parser<T>, body?: unknown) =>
    request(schema, { method: "POST", path, body }),
  patch: <T>(path: string, schema: Parser<T>, body?: unknown) =>
    request(schema, { method: "PATCH", path, body }),
  put: <T>(path: string, schema: Parser<T>, body?: unknown) =>
    request(schema, { method: "PUT", path, body }),
  del: <T>(path: string, schema: Parser<T>, body?: unknown) =>
    request(schema, { method: "DELETE", path, body }),
  upload: <T>(path: string, schema: Parser<T>, form: FormData) =>
    request(schema, { method: "POST", path, form }),
  uploadPut: <T>(path: string, schema: Parser<T>, form: FormData) =>
    request(schema, { method: "PUT", path, form }),
};

// The RTC signaling layer (S7.2) reaches the PUT rtc routes (§6.1) through this same client, so it
// needs the client's shape as a type — S4.3 exported only the value.
export type ApiClient = typeof apiClient;
