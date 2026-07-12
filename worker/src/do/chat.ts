import { z } from "zod";
import { ChatMessage, GifAttachment, ImageAttachment, LIMITS } from "@tavern/shared";
import type { Member } from "@tavern/shared";

// Server-side mention scan (pinned regex, §S3.2 task 4). `g` is required for matchAll; `i` makes the
// handle capture case-insensitive (usernames are stored lowercase, so we lowercase the capture too).
// matchAll clones the regexp internally, so a module-scoped instance carries no `lastIndex` state.
const MENTION_RE = /@([a-z0-9_]{3,20})/gi;

// Per-user token bucket for chat sends (§S3.2 task 3). Held in a per-ChatModule-instance Map — one
// ChatModule per DO, so buckets are per-server. In-memory is pinned: a DO eviction resets the bucket,
// which only ever REFILLS a user's budget (never revokes) — acceptable.
type Bucket = { tokens: number; lastRefillAt: number };

// The mentions column round-trips as a JSON array of userIds; validate it on read (§9.8 / A9: SQL
// read-back is a trust boundary) so a corrupt row can never widen into an unvalidated wire frame.
const mentionsColumn = z.array(z.uuid());

// Owns the `messages` table: validation + rate limit + server-side mention extraction + persistence +
// paginated history. The DO wires `send`/`history` into the WS router; `lastMessageId` feeds hello.ok
// and `messageCountByUser` feeds S3.4's stats. No schema change — the table is S3.1's migration.
export class ChatModule {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly sql: SqlStorage) {}

  send(input: {
    userId: string;
    body: string;
    nonce: string;
    members: Member[];
    now: number;
    gif?: GifAttachment;
    image?: ImageAttachment;
  }): { ok: true; message: ChatMessage } | { ok: false; code: "bad_message" | "rate_limited" } {
    // Trust-boundary re-check of what the client schema already enforces (defense-in-depth: a direct
    // call that bypassed `clientMessageSchema` still cannot persist). Body may be empty ONLY when a
    // gif or image accompanies it; either way an over-length body is rejected.
    if (input.body.length > LIMITS.messageMaxChars) {
      return { ok: false, code: "bad_message" };
    }
    if (input.body.length < 1 && input.gif === undefined && input.image === undefined) {
      return { ok: false, code: "bad_message" };
    }
    if (!this.consumeToken(input.userId, input.now)) {
      return { ok: false, code: "rate_limited" };
    }
    const mentions = extractMentions(input.body, input.members);
    const row = this.sql
      .exec<Record<string, SqlStorageValue>>(
        `INSERT INTO messages (channel_id, user_id, body, mentions, gif, image, created_at)
         VALUES ('main', ?, ?, ?, ?, ?, ?) RETURNING id`,
        input.userId,
        input.body,
        JSON.stringify(mentions),
        input.gif === undefined ? null : JSON.stringify(input.gif),
        input.image === undefined ? null : JSON.stringify(input.image),
        input.now,
      )
      .one();
    const message: ChatMessage = {
      id: Number(row["id"]),
      userId: input.userId,
      body: input.body,
      mentions,
      at: input.now,
      ...(input.gif === undefined ? {} : { gif: input.gif }),
      ...(input.image === undefined ? {} : { image: input.image }),
    };
    return { ok: true, message };
  }

  // Newest-first window of `min(limit, historyPageSize)` rows, returned oldest→newest within the page.
  // `hasMore` is true when a further (older) row exists beyond the window — detected by fetching one
  // extra row rather than a second COUNT query.
  history(input: { beforeId?: number; limit: number }): {
    messages: ChatMessage[];
    hasMore: boolean;
  } {
    const limit = Math.min(input.limit, LIMITS.historyPageSize);
    const window = limit + 1;
    const rows =
      input.beforeId === undefined
        ? this.sql
            .exec<Record<string, SqlStorageValue>>(
              `SELECT id, user_id, body, mentions, gif, image, created_at FROM messages
               ORDER BY id DESC LIMIT ?`,
              window,
            )
            .toArray()
        : this.sql
            .exec<Record<string, SqlStorageValue>>(
              `SELECT id, user_id, body, mentions, gif, image, created_at FROM messages
               WHERE id < ? ORDER BY id DESC LIMIT ?`,
              input.beforeId,
              window,
            )
            .toArray();
    const hasMore = rows.length > limit;
    // Query is newest-first (id DESC); reverse to oldest→newest within the page. `toReversed` returns a
    // fresh array (the mapped array is already a copy, but the linter forbids the mutating `reverse`).
    const messages = rows.slice(0, limit).map(rowToChatMessage).toReversed();
    return { messages, hasMore };
  }

  // Max persisted message id (0 when empty) — feeds hello.ok.lastMessageId so a reconnecting client
  // knows the high-water mark without a history round-trip.
  lastMessageId(): number {
    const row = this.sql
      .exec<Record<string, SqlStorageValue>>(`SELECT MAX(id) AS max_id FROM messages`)
      .one();
    const maxId = row["max_id"];
    return maxId === null || maxId === undefined ? 0 : Number(maxId);
  }

  // Messages-sent-per-user counts (FR-40 stat; consumed by S3.4's /internal/stats). No counter table —
  // §5.2 pins this as a GROUP BY over the messages rows.
  messageCountByUser(): Map<string, number> {
    const rows = this.sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT user_id, COUNT(*) AS count FROM messages GROUP BY user_id`,
      )
      .toArray();
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(String(row["user_id"]), Number(row["count"]));
    return counts;
  }

  // Classic token bucket: capacity `rateChatBurst`, refill `rateChatPerSec`. Refills lazily on each
  // send by the wall-clock elapsed since the last touch, clamped to capacity. A first send seeds a
  // full bucket. `now` is passed in (server clock) so callers stay testable.
  private consumeToken(userId: string, now: number): boolean {
    const bucket = this.buckets.get(userId) ?? {
      tokens: LIMITS.rateChatBurst,
      lastRefillAt: now,
    };
    const elapsedSec = Math.max(0, now - bucket.lastRefillAt) / 1000;
    const tokens = Math.min(
      LIMITS.rateChatBurst,
      bucket.tokens + elapsedSec * LIMITS.rateChatPerSec,
    );
    if (tokens < 1) {
      this.buckets.set(userId, { tokens, lastRefillAt: now });
      return false;
    }
    this.buckets.set(userId, { tokens: tokens - 1, lastRefillAt: now });
    return true;
  }
}

// Extracts mentioned userIds from a body: match the pinned handle regex, resolve each capture
// case-insensitively against current member usernames, dedupe, keep first-occurrence order.
// Non-member handles are silently dropped.
function extractMentions(body: string, members: Member[]): string[] {
  const byUsername = new Map<string, string>();
  for (const member of members) byUsername.set(member.username.toLowerCase(), member.userId);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const match of body.matchAll(MENTION_RE)) {
    const handle = match[1];
    if (handle === undefined) continue;
    const userId = byUsername.get(handle.toLowerCase());
    if (userId === undefined || seen.has(userId)) continue;
    seen.add(userId);
    result.push(userId);
  }
  return result;
}

// Typed `messages` row → the shared `ChatMessage` wire type; `ChatMessage.parse` validates the
// read-back (mentions JSON included) so downstream frames are always contract-valid.
function rowToChatMessage(row: Record<string, SqlStorageValue>): ChatMessage {
  const mentions: unknown = mentionsColumn.parse(JSON.parse(String(row["mentions"])));
  // `gif` is a nullable JSON column (NULL for text-only rows, incl. every row that predates the
  // migration). Validate the read-back so a corrupt/legacy blob can't widen into an unchecked frame.
  const gifRaw = row["gif"];
  const gif =
    gifRaw === null || gifRaw === undefined
      ? undefined
      : GifAttachment.parse(JSON.parse(String(gifRaw)));
  // Same nullable-JSON read-back trust boundary as `gif` (NULL for text/gif-only + pre-migration rows).
  const imageRaw = row["image"];
  const image =
    imageRaw === null || imageRaw === undefined
      ? undefined
      : ImageAttachment.parse(JSON.parse(String(imageRaw)));
  return ChatMessage.parse({
    id: Number(row["id"]),
    userId: String(row["user_id"]),
    body: String(row["body"]),
    mentions,
    at: Number(row["created_at"]),
    ...(gif === undefined ? {} : { gif }),
    ...(image === undefined ? {} : { image }),
  });
}
