import { Hono } from "hono";
import type { ErrorCode } from "@tavern/shared";
import { ServerRoom } from "./do/ServerRoom";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true }));

// Hono's default notFound is plain text; the app-wide envelope is { error: ErrorCode }.
app.notFound((c) => c.json({ error: "not_found" satisfies ErrorCode }, 404));

export default app;
export { ServerRoom };
