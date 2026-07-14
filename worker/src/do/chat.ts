import { z } from "zod";
import {
  ChatMessage,
  ChatReaction,
  ChatReply,
  GifAttachment,
  ImageAttachment,
  LIMITS,
  ReactionEmoji,
} from "@tavern/shared";
import type { Member } from "@tavern/shared";

const MENTION_RE = /@([a-z0-9_]{3,20})/gi;
type Bucket = { tokens: number; lastRefillAt: number };
const mentionsColumn = z.array(z.uuid());

export interface ChatReadState {
  lastReadMessageId: number;
  firstUnreadMessageId: number | null;
  unreadCount: number;
}

export type HistoryMode = "initial" | "latest" | "older" | "newer" | "around";

const SELECT_MESSAGE = `SELECT
  m.id, m.user_id, m.body, m.mentions, m.gif, m.image, m.created_at, m.edited_at, m.deleted_at,
  r.id AS reply_id, r.user_id AS reply_user_id, r.body AS reply_body,
  r.gif AS reply_gif, r.image AS reply_image, r.deleted_at AS reply_deleted_at
  FROM messages m LEFT JOIN messages r ON r.id = m.reply_to_id`;

export class ChatModule {
  private readonly buckets = new Map<string, Bucket>();
  private readonly reactionBuckets = new Map<string, Bucket>();

  constructor(private readonly sql: SqlStorage) {}

  initializeReadCursor(userId: string): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO message_reads (user_id, last_read_id) VALUES (?, ?)`,
      userId,
      this.lastMessageId(),
    );
  }

  readState(userId: string): ChatReadState {
    this.initializeReadCursor(userId);
    const row = this.sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT mr.last_read_id,
          (SELECT MIN(id) FROM messages
             WHERE id > mr.last_read_id AND user_id <> ? AND deleted_at IS NULL) AS first_unread_id,
          (SELECT COUNT(*) FROM messages
             WHERE id > mr.last_read_id AND user_id <> ? AND deleted_at IS NULL) AS unread_count
         FROM message_reads mr WHERE mr.user_id = ?`,
        userId,
        userId,
        userId,
      )
      .one();
    return {
      lastReadMessageId: Number(row["last_read_id"]),
      firstUnreadMessageId: nullableNumber(row["first_unread_id"]),
      unreadCount: Number(row["unread_count"]),
    };
  }

  markRead(userId: string, messageId: number): ChatReadState | null {
    const maxId = this.lastMessageId();
    if (messageId < 1 || messageId > maxId) return null;
    this.initializeReadCursor(userId);
    this.sql.exec(
      `UPDATE message_reads SET last_read_id = ? WHERE user_id = ? AND last_read_id < ?`,
      messageId,
      userId,
      messageId,
    );
    return this.readState(userId);
  }

  send(input: {
    userId: string;
    body: string;
    nonce: string;
    members: Member[];
    now: number;
    gif?: GifAttachment;
    image?: ImageAttachment;
    replyToId?: number;
  }):
    | { ok: true; message: ChatMessage }
    | { ok: false; code: "bad_message" | "rate_limited" | "not_found" } {
    if (input.body.length > LIMITS.messageMaxChars) return { ok: false, code: "bad_message" };
    if (input.body.length < 1 && input.gif === undefined && input.image === undefined) {
      return { ok: false, code: "bad_message" };
    }
    if (input.replyToId !== undefined && this.replyById(input.replyToId) === null) {
      return { ok: false, code: "not_found" };
    }
    if (!this.consumeToken(input.userId, input.now)) return { ok: false, code: "rate_limited" };

    const mentions = extractMentions(input.body, input.members);
    const row = this.sql
      .exec<Record<string, SqlStorageValue>>(
        `INSERT INTO messages
          (channel_id, user_id, body, mentions, gif, image, reply_to_id, created_at)
         VALUES ('main', ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        input.userId,
        input.body,
        JSON.stringify(mentions),
        input.gif === undefined ? null : JSON.stringify(input.gif),
        input.image === undefined ? null : JSON.stringify(input.image),
        input.replyToId ?? null,
        input.now,
      )
      .one();
    return { ok: true, message: this.messageById(Number(row["id"])) };
  }

  edit(input: {
    userId: string;
    messageId: number;
    body: string;
    members: Member[];
    now: number;
  }):
    | { ok: true; message: ChatMessage }
    | { ok: false; code: "bad_message" | "forbidden" | "not_found" } {
    const current = this.messageByIdOrNull(input.messageId);
    if (current === null || current.deletedAt !== undefined)
      return { ok: false, code: "not_found" };
    if (current.userId !== input.userId) return { ok: false, code: "forbidden" };
    const latest = this.sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT id FROM messages WHERE user_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`,
        input.userId,
      )
      .one();
    if (Number(latest["id"]) !== input.messageId) return { ok: false, code: "forbidden" };
    const body = input.body.trim();
    if (body.length > LIMITS.messageMaxChars) return { ok: false, code: "bad_message" };
    if (body.length === 0 && current.gif === undefined && current.image === undefined) {
      return { ok: false, code: "bad_message" };
    }
    this.sql.exec(
      `UPDATE messages SET body = ?, mentions = ?, edited_at = ? WHERE id = ?`,
      body,
      JSON.stringify(extractMentions(body, input.members)),
      input.now,
      input.messageId,
    );
    return { ok: true, message: this.messageById(input.messageId) };
  }

  delete(input: {
    userId: string;
    messageId: number;
    now: number;
  }):
    | { ok: true; message: ChatMessage; imageId?: string }
    | { ok: false; code: "forbidden" | "not_found" } {
    const current = this.messageByIdOrNull(input.messageId);
    if (current === null) return { ok: false, code: "not_found" };
    if (current.userId !== input.userId) return { ok: false, code: "forbidden" };
    if (current.deletedAt !== undefined) return { ok: true, message: current };
    const imageId = current.image?.id;
    if (imageId !== undefined) {
      this.sql.exec(
        `INSERT OR IGNORE INTO chat_image_cleanup (image_id, message_id) VALUES (?, ?)`,
        imageId,
        input.messageId,
      );
    }
    this.sql.exec(`DELETE FROM message_reactions WHERE message_id = ?`, input.messageId);
    this.sql.exec(
      `UPDATE messages SET body = '', mentions = '[]', gif = NULL, image = NULL,
       edited_at = NULL, deleted_at = ? WHERE id = ?`,
      input.now,
      input.messageId,
    );
    return {
      ok: true,
      message: this.messageById(input.messageId),
      ...(imageId === undefined ? {} : { imageId }),
    };
  }

  setReaction(input: {
    userId: string;
    displayName: string;
    messageId: number;
    emoji: string;
    reacted: boolean;
    now: number;
  }):
    | { ok: true; emoji: string; reaction: ChatReaction | null; changed: boolean }
    | { ok: false; code: "bad_message" | "not_found" | "rate_limited" } {
    const parsedEmoji = ReactionEmoji.safeParse(input.emoji);
    if (!parsedEmoji.success) return { ok: false, code: "bad_message" };
    const message = this.messageByIdOrNull(input.messageId);
    if (message === null || message.deletedAt !== undefined)
      return { ok: false, code: "not_found" };
    if (
      !consumeFromBucket(
        this.reactionBuckets,
        input.userId,
        input.now,
        LIMITS.rateReactionPerSec,
        LIMITS.rateReactionBurst,
      )
    ) {
      return { ok: false, code: "rate_limited" };
    }

    const emoji = parsedEmoji.data;
    const existed =
      this.sql
        .exec<Record<string, SqlStorageValue>>(
          `SELECT 1 AS found FROM message_reactions
           WHERE message_id = ? AND user_id = ? AND emoji = ? LIMIT 1`,
          input.messageId,
          input.userId,
          emoji,
        )
        .toArray().length > 0;
    if (input.reacted) {
      this.sql.exec(
        `INSERT INTO message_reactions(message_id, user_id, emoji, display_name, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(message_id, user_id, emoji) DO UPDATE SET display_name = excluded.display_name`,
        input.messageId,
        input.userId,
        emoji,
        input.displayName,
        input.now,
      );
    } else {
      this.sql.exec(
        `DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?`,
        input.messageId,
        input.userId,
        emoji,
      );
    }
    return {
      ok: true,
      emoji,
      reaction: this.reactionByEmoji(input.messageId, emoji),
      changed: existed !== input.reacted,
    };
  }

  refreshReactorDisplayName(userId: string, displayName: string): void {
    this.sql.exec(
      `UPDATE message_reactions SET display_name = ? WHERE user_id = ?`,
      displayName,
      userId,
    );
  }

  history(input: { userId: string; mode: HistoryMode; cursorId?: number; limit: number }): {
    messages: ChatMessage[];
    hasOlder: boolean;
    hasNewer: boolean;
  } {
    const limit = Math.min(input.limit, LIMITS.historyPageSize);
    let rows: Record<string, SqlStorageValue>[];

    if (input.mode === "initial") {
      const firstUnread = this.readState(input.userId).firstUnreadMessageId;
      if (firstUnread === null) {
        rows = this.query(`${SELECT_MESSAGE} ORDER BY m.id DESC LIMIT ?`, limit).toReversed();
      } else {
        const olderLimit = Math.floor(limit / 3);
        const older = this.query(
          `${SELECT_MESSAGE} WHERE m.id < ? ORDER BY m.id DESC LIMIT ?`,
          firstUnread,
          olderLimit,
        ).toReversed();
        const newer = this.query(
          `${SELECT_MESSAGE} WHERE m.id >= ? ORDER BY m.id ASC LIMIT ?`,
          firstUnread,
          limit - older.length,
        );
        rows = [...older, ...newer];
      }
    } else if (input.mode === "latest") {
      rows = this.query(`${SELECT_MESSAGE} ORDER BY m.id DESC LIMIT ?`, limit).toReversed();
    } else if (input.mode === "older") {
      if (input.cursorId === undefined) return { messages: [], hasOlder: false, hasNewer: false };
      rows = this.query(
        `${SELECT_MESSAGE} WHERE m.id < ? ORDER BY m.id DESC LIMIT ?`,
        input.cursorId,
        limit,
      ).toReversed();
    } else if (input.mode === "newer") {
      if (input.cursorId === undefined) return { messages: [], hasOlder: false, hasNewer: false };
      rows = this.query(
        `${SELECT_MESSAGE} WHERE m.id > ? ORDER BY m.id ASC LIMIT ?`,
        input.cursorId,
        limit,
      );
    } else {
      if (input.cursorId === undefined) return { messages: [], hasOlder: false, hasNewer: false };
      const beforeLimit = Math.floor(limit / 2);
      const before = this.query(
        `${SELECT_MESSAGE} WHERE m.id <= ? ORDER BY m.id DESC LIMIT ?`,
        input.cursorId,
        beforeLimit + 1,
      ).toReversed();
      const after = this.query(
        `${SELECT_MESSAGE} WHERE m.id > ? ORDER BY m.id ASC LIMIT ?`,
        input.cursorId,
        limit - before.length,
      );
      rows = [...before, ...after];
    }

    const reactions = this.reactionsForMessages(rows.map((row) => Number(row["id"])));
    const messages = rows.map((row) =>
      rowToChatMessage(row, reactions.get(Number(row["id"])) ?? []),
    );
    const first = messages[0]?.id;
    const last = messages.at(-1)?.id;
    return {
      messages,
      hasOlder: first !== undefined && this.existsBefore(first),
      hasNewer: last !== undefined && this.existsAfter(last),
    };
  }

  lastMessageId(): number {
    const row = this.sql
      .exec<Record<string, SqlStorageValue>>(`SELECT MAX(id) AS max_id FROM messages`)
      .one();
    return nullableNumber(row["max_id"]) ?? 0;
  }

  messageCountByUser(): Map<string, number> {
    const rows = this.sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT user_id, COUNT(*) AS count FROM messages GROUP BY user_id`,
      )
      .toArray();
    return new Map(rows.map((row) => [String(row["user_id"]), Number(row["count"])]));
  }

  pendingImageCleanup(): string[] {
    return this.sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT c.image_id FROM chat_image_cleanup c
         JOIN messages m ON m.id = c.message_id
         WHERE m.deleted_at IS NOT NULL ORDER BY c.image_id`,
      )
      .toArray()
      .map((row) => String(row["image_id"]));
  }

  completeImageCleanup(imageId: string): void {
    this.sql.exec(`DELETE FROM chat_image_cleanup WHERE image_id = ?`, imageId);
  }

  hasPendingImageCleanup(): boolean {
    return (
      Number(
        this.sql
          .exec<Record<string, SqlStorageValue>>(
            `SELECT EXISTS(
               SELECT 1 FROM chat_image_cleanup c
               JOIN messages m ON m.id = c.message_id
               WHERE m.deleted_at IS NOT NULL
             ) AS found`,
          )
          .one()["found"],
      ) === 1
    );
  }

  private messageById(id: number): ChatMessage {
    const message = this.messageByIdOrNull(id);
    if (message === null) throw new Error(`message ${id} disappeared after persistence`);
    return message;
  }

  private messageByIdOrNull(id: number): ChatMessage | null {
    const rows = this.query(`${SELECT_MESSAGE} WHERE m.id = ?`, id);
    const row = rows[0];
    return row === undefined
      ? null
      : rowToChatMessage(row, this.reactionsForMessages([id]).get(id) ?? []);
  }

  private reactionByEmoji(messageId: number, emoji: string): ChatReaction | null {
    return (
      this.reactionsForMessages([messageId])
        .get(messageId)
        ?.find((item) => item.emoji === emoji) ?? null
    );
  }

  private reactionsForMessages(messageIds: number[]): Map<number, ChatReaction[]> {
    const result = new Map<number, ChatReaction[]>();
    if (messageIds.length === 0) return result;
    const placeholders = messageIds.map(() => "?").join(", ");
    const rows = this.sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT message_id, user_id, emoji, display_name, created_at
         FROM message_reactions WHERE message_id IN (${placeholders})
         ORDER BY message_id, created_at, user_id`,
        ...messageIds,
      )
      .toArray();
    const reactionByKey = new Map<string, ChatReaction>();
    for (const row of rows) {
      const messageId = Number(row["message_id"]);
      const emoji = String(row["emoji"]);
      const key = `${messageId}:${emoji}`;
      let reaction = reactionByKey.get(key);
      if (reaction === undefined) {
        reaction = { emoji, reactors: [] };
        reactionByKey.set(key, reaction);
        const messageReactions = result.get(messageId) ?? [];
        messageReactions.push(reaction);
        result.set(messageId, messageReactions);
      }
      reaction.reactors.push({
        userId: String(row["user_id"]),
        displayName: String(row["display_name"]),
      });
    }
    for (const reactions of result.values()) {
      for (const reaction of reactions) ChatReaction.parse(reaction);
    }
    return result;
  }

  private replyById(id: number): ChatReply | null {
    const message = this.messageByIdOrNull(id);
    if (message === null || message.deletedAt !== undefined) return null;
    return toReply(message);
  }

  private query(
    statement: string,
    ...bindings: (string | number)[]
  ): Record<string, SqlStorageValue>[] {
    return this.sql.exec<Record<string, SqlStorageValue>>(statement, ...bindings).toArray();
  }

  private existsBefore(id: number): boolean {
    return (
      Number(
        this.sql
          .exec<Record<string, SqlStorageValue>>(
            `SELECT EXISTS(SELECT 1 FROM messages WHERE id < ?) AS found`,
            id,
          )
          .one()["found"],
      ) === 1
    );
  }

  private existsAfter(id: number): boolean {
    return (
      Number(
        this.sql
          .exec<Record<string, SqlStorageValue>>(
            `SELECT EXISTS(SELECT 1 FROM messages WHERE id > ?) AS found`,
            id,
          )
          .one()["found"],
      ) === 1
    );
  }

  private consumeToken(userId: string, now: number): boolean {
    return consumeFromBucket(
      this.buckets,
      userId,
      now,
      LIMITS.rateChatPerSec,
      LIMITS.rateChatBurst,
    );
  }
}

function consumeFromBucket(
  buckets: Map<string, Bucket>,
  userId: string,
  now: number,
  refillPerSec: number,
  burst: number,
): boolean {
  const bucket = buckets.get(userId) ?? { tokens: burst, lastRefillAt: now };
  const elapsedSec = Math.max(0, now - bucket.lastRefillAt) / 1000;
  const tokens = Math.min(burst, bucket.tokens + elapsedSec * refillPerSec);
  if (tokens < 1) {
    buckets.set(userId, { tokens, lastRefillAt: now });
    return false;
  }
  buckets.set(userId, { tokens: tokens - 1, lastRefillAt: now });
  return true;
}

function nullableNumber(value: SqlStorageValue | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function extractMentions(body: string, members: Member[]): string[] {
  const byUsername = new Map(
    members.map((member) => [member.username.toLowerCase(), member.userId]),
  );
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

function parseOptional<T>(schema: z.ZodType<T>, value: SqlStorageValue | undefined): T | undefined {
  return value === null || value === undefined
    ? undefined
    : schema.parse(JSON.parse(String(value)));
}

function rowToChatMessage(
  row: Record<string, SqlStorageValue>,
  reactions: ChatReaction[],
): ChatMessage {
  const gif = parseOptional(GifAttachment, row["gif"]);
  const image = parseOptional(ImageAttachment, row["image"]);
  const replyGif = parseOptional(GifAttachment, row["reply_gif"]);
  const replyImage = parseOptional(ImageAttachment, row["reply_image"]);
  const replyId = nullableNumber(row["reply_id"]);
  const reply =
    replyId === null
      ? undefined
      : ChatReply.parse({
          id: replyId,
          userId: String(row["reply_user_id"]),
          body: String(row["reply_body"]),
          deleted: row["reply_deleted_at"] !== null && row["reply_deleted_at"] !== undefined,
          ...(replyGif === undefined ? {} : { gif: replyGif }),
          ...(replyImage === undefined ? {} : { image: replyImage }),
        });
  return ChatMessage.parse({
    id: Number(row["id"]),
    userId: String(row["user_id"]),
    body: String(row["body"]),
    mentions: mentionsColumn.parse(JSON.parse(String(row["mentions"]))),
    at: Number(row["created_at"]),
    ...(gif === undefined ? {} : { gif }),
    ...(image === undefined ? {} : { image }),
    ...(reply === undefined ? {} : { reply }),
    reactions,
    ...(nullableNumber(row["edited_at"]) === null ? {} : { editedAt: Number(row["edited_at"]) }),
    ...(nullableNumber(row["deleted_at"]) === null ? {} : { deletedAt: Number(row["deleted_at"]) }),
  });
}

function toReply(message: ChatMessage): ChatReply {
  return {
    id: message.id,
    userId: message.userId,
    body: message.body,
    deleted: message.deletedAt !== undefined,
    ...(message.gif === undefined ? {} : { gif: message.gif }),
    ...(message.image === undefined ? {} : { image: message.image }),
  };
}
