import { DurableObject } from "cloudflare:workers";
import {
  clientMessageSchema,
  CLOSE_BAD_TICKET,
  CLOSE_KICKED,
  CLOSE_PROTOCOL_VIOLATION,
  LIMITS,
  MemberInit,
  UserProfile,
} from "@tavern/shared";
import type { ClientMessage, ErrorCode } from "@tavern/shared";
import { migrate } from "./sql";
import { RoomState } from "./roomState";
import type { ConnAttachment, RoomMeta } from "./roomState";
import { ChatModule } from "./chat";

// The Worker sets this header on EVERY DO stub call; the DO has no other ingress path, so a missing
// header on an /internal/* route means the request did not originate from the Worker → 403.
const INTERNAL_HEADER = "X-Tavern-Internal";

// The per-server Durable Object: WebSocket lifecycle + internal-route dispatch + message router ONLY.
// All state logic lives in RoomState; all schema/migration in sql.ts.
export class ServerRoom extends DurableObject<Env> {
  private readonly room: RoomState;
  // One ChatModule per DO → its rate-limit buckets are per-server (§S3.2 task 3).
  private readonly chat: ChatModule;
  // connId → hello-timeout handle (in-memory; a 5 s pending timer keeps the DO from hibernating, so
  // the same instance handles the hello within the window — negligible cost, §S3.1 task 6).
  private readonly helloTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // The message router later steps plug domain modules into. This step implements `hello`; every
  // other valid type answers `not_implemented` until S3.2/S3.4/S8/S9 fill the map (S12.4 verifies none
  // remain). `ping` never reaches here — setWebSocketAutoResponse answers it without waking the DO.
  private readonly routes: Record<
    ClientMessage["t"],
    (ws: WebSocket, att: ConnAttachment, msg: ClientMessage) => void
  >;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.room = new RoomState(ctx, env);
    this.chat = new ChatModule(ctx.storage.sql);
    this.routes = {
      hello: (ws, att) => this.handleHello(ws, att),
      "chat.send": (ws, att, msg) => this.handleChatSend(ws, att, msg),
      "chat.history": (ws, att, msg) => this.handleChatHistory(ws, att, msg),
      "voice.join": (ws) => this.notImplemented(ws),
      "voice.leave": (ws) => this.notImplemented(ws),
      "voice.state": (ws) => this.notImplemented(ws),
      "stream.start": (ws) => this.notImplemented(ws),
      "stream.preset": (ws) => this.notImplemented(ws),
      "stream.stop": (ws) => this.notImplemented(ws),
      "watch.start": (ws) => this.notImplemented(ws),
      "watch.stop": (ws) => this.notImplemented(ws),
      "sound.play": (ws) => this.notImplemented(ws),
      "rec.start": (ws) => this.notImplemented(ws),
      "rec.stop": (ws) => this.notImplemented(ws),
      ping: (ws) => this.notImplemented(ws),
    };
    ctx.blockConcurrencyWhile(async () => {
      migrate(ctx.storage.sql);
      await this.room.load();
    });
    // Protocol pings answered without waking the DO (App-A `ping`/`pong`).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // The Worker forwards the upgrade Request unchanged (preserving WS semantics), so the path is
    // the client's `/api/servers/:id/ws`; direct DO-stub tests use `/ws`. Both end in `/ws`.
    if (url.pathname.endsWith("/ws")) return this.handleUpgrade(request, url);
    if (url.pathname.startsWith("/internal/")) {
      if (request.headers.get(INTERNAL_HEADER) !== "1") {
        return Response.json({ error: "forbidden" satisfies ErrorCode }, { status: 403 });
      }
      return this.handleInternal(request, url.pathname);
    }
    return Response.json({ error: "not_implemented" satisfies ErrorCode }, { status: 501 });
  }

  // GET /ws?ticket=… — consume the one-time ticket, accept the hibernatable socket, arm the hello
  // timeout. An invalid ticket accepts then closes 4002 so the client can re-ticket (a plain 403
  // gives browsers an opaque error).
  private async handleUpgrade(request: Request, url: URL): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return Response.json({ error: "bad_request" satisfies ErrorCode }, { status: 426 });
    }
    const ticket = url.searchParams.get("ticket");
    const userId = ticket === null ? null : await this.room.consumeTicket(ticket);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);

    if (userId === null) {
      server.close(CLOSE_BAD_TICKET, "ticket");
      return new Response(null, { status: 101, webSocket: client });
    }

    const attachment: ConnAttachment = { userId, connId: crypto.randomUUID(), hello: false };
    server.serializeAttachment(attachment);
    const timer = setTimeout(() => {
      const att: ConnAttachment | null = server.deserializeAttachment();
      if (att !== null && !att.hello) server.close(CLOSE_PROTOCOL_VIOLATION, "hello timeout");
      this.helloTimers.delete(attachment.connId);
    }, LIMITS.helloTimeoutMs);
    this.helloTimers.set(attachment.connId, timer);
    return new Response(null, { status: 101, webSocket: client });
  }

  // Worker-only ingress (header-guarded by fetch). Each route is a Worker→DO plumbing call.
  private async handleInternal(request: Request, pathname: string): Promise<Response> {
    const at = Date.now();
    switch (pathname) {
      case "/internal/ticket": {
        const body: { userId: string } = await request.json();
        return Response.json({ ticket: await this.room.createTicket(body.userId) });
      }
      case "/internal/member-join": {
        const body: { member: unknown; serverMeta: RoomMeta } = await request.json();
        const member = MemberInit.parse(body.member);
        this.room.upsertMember(member);
        await this.room.setMeta(body.serverMeta);
        this.room.broadcast({
          t: "member.joined",
          member: { ...member, presence: this.room.presenceOf(member.userId) },
          at,
        });
        return new Response(null, { status: 204 });
      }
      case "/internal/member-update": {
        const body: { profile: unknown } = await request.json();
        const profile = UserProfile.parse(body.profile);
        this.room.updateProfile(profile);
        this.room.broadcast({ t: "member.update", profile, at });
        return new Response(null, { status: 204 });
      }
      case "/internal/kick": {
        const body: { userId: string } = await request.json();
        this.room.removeMember(body.userId);
        this.room.broadcast({ t: "member.left", userId: body.userId, at });
        for (const ws of this.room.socketsOf(body.userId)) ws.close(CLOSE_KICKED, "kicked");
        return new Response(null, { status: 204 });
      }
      case "/internal/server-updated": {
        const body: { nickname: string } = await request.json();
        await this.room.patchNickname(body.nickname);
        this.room.broadcast({ t: "server.updated", nickname: body.nickname, at });
        return new Response(null, { status: 204 });
      }
      default:
        return Response.json({ error: "not_found" satisfies ErrorCode }, { status: 404 });
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att: ConnAttachment | null = ws.deserializeAttachment();
    if (att === null) {
      ws.close(CLOSE_PROTOCOL_VIOLATION, "no attachment");
      return;
    }
    if (typeof message !== "string") {
      this.rejectFrame(ws);
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(message);
    } catch {
      this.rejectFrame(ws);
      return;
    }
    const parsed = clientMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.rejectFrame(ws);
      return;
    }
    const msg = parsed.data;
    // The first frame MUST be `hello`; any other (even a valid) type before the handshake is fatal.
    if (!att.hello && msg.t !== "hello") {
      this.rejectFrame(ws);
      return;
    }
    this.routes[msg.t](ws, att, msg);
  }

  webSocketClose(ws: WebSocket): void {
    this.handleDisconnect(ws);
  }

  webSocketError(ws: WebSocket): void {
    this.handleDisconnect(ws);
  }

  private handleDisconnect(ws: WebSocket): void {
    const att: ConnAttachment | null = ws.deserializeAttachment();
    if (att === null) return;
    const timer = this.helloTimers.get(att.connId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.helloTimers.delete(att.connId);
    }
    this.room.presenceOnClose(ws, att, Date.now());
  }

  private handleHello(ws: WebSocket, att: ConnAttachment): void {
    const at = Date.now();
    const firstHello = !att.hello;
    if (firstHello) {
      const next: ConnAttachment = { ...att, hello: true };
      ws.serializeAttachment(next);
      const timer = this.helloTimers.get(att.connId);
      if (timer !== undefined) {
        clearTimeout(timer);
        this.helloTimers.delete(att.connId);
      }
    }
    // Reconnect replays the full snapshot (§6.2 no delta sync); a repeat hello is idempotent.
    this.room.send(ws, this.room.helloSnapshot(att.userId, this.chat.lastMessageId()));
    if (firstHello) this.room.presenceOnHello(ws, att.userId, at);
  }

  // chat.send: validate + rate-limit + extract mentions + persist (ChatModule), then broadcast
  // `chat.new` — the sender's copies carry the echoed nonce, every other socket's copy omits it.
  private handleChatSend(ws: WebSocket, att: ConnAttachment, msg: ClientMessage): void {
    if (msg.t !== "chat.send") return;
    const result = this.chat.send({
      userId: att.userId,
      body: msg.body,
      nonce: msg.nonce,
      members: this.room.listMembers(),
      now: Date.now(),
    });
    if (!result.ok) {
      // rate_limited (and the defense-in-depth bad_message) reply on this socket only; it stays open.
      this.room.send(ws, { t: "error", code: result.code });
      return;
    }
    const message = result.message;
    this.room.broadcast({ t: "chat.new", message, nonce: msg.nonce }, { toUserId: att.userId });
    this.room.broadcast({ t: "chat.new", message }, { except: this.room.socketsOf(att.userId) });
  }

  // chat.history: paginated read (ChatModule), replied only to the requesting socket.
  private handleChatHistory(ws: WebSocket, att: ConnAttachment, msg: ClientMessage): void {
    if (msg.t !== "chat.history") return;
    const page = this.chat.history({
      ...(msg.beforeId === undefined ? {} : { beforeId: msg.beforeId }),
      limit: msg.limit,
    });
    this.room.send(ws, { t: "chat.page", messages: page.messages, hasMore: page.hasMore });
  }

  private rejectFrame(ws: WebSocket): void {
    this.room.send(ws, { t: "error", code: "bad_message" });
    ws.close(CLOSE_PROTOCOL_VIOLATION, "bad_message");
  }

  private notImplemented(ws: WebSocket): void {
    this.room.send(ws, { t: "error", code: "not_implemented" });
  }
}
