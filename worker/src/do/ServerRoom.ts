import { DurableObject } from "cloudflare:workers";
import type { ErrorCode } from "@tavern/shared";

// Placeholder ServerRoom DO — real WS lifecycle + state machine land in S3.1.
// Exists now so the SERVER_ROOM binding (wrangler.jsonc migration tag v1) deploys.
export class ServerRoom extends DurableObject<Env> {
  fetch(_request: Request): Response {
    return Response.json({ error: "not_implemented" satisfies ErrorCode }, { status: 501 });
  }
}
