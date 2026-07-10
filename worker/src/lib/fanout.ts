import type { UserProfile } from "@tavern/shared";

// The internal message the Worker pushes to a server's ServerRoom DO when a member's profile
// changes (FR-03/FR-04/FR-05 live propagation). It is declared HERE because it exists nowhere else
// in the plan: this fan-out seam is the only producer of it (S1.3 task 3). S3.1's DO consumes it.
export type ServerInternalMsg = { t: "member.update"; profile: UserProfile };

// Pushes `msg` to every server the user has joined, by POSTing to each ServerRoom DO's
// `/internal/member-update`. `/internal/*` is reachable ONLY through a DO stub — never routed by the
// Hono app (S1.3 task 3). PINNED: S1.3 only CREATES this helper + its unit seam; it is NOT wired into
// any route yet — the `memberships` table lands in S2.1, which also wires this call into
// PATCH /api/me/profile and avatar upload. The DO's `/internal/member-update` handler lands in S3.1;
// until then the placeholder DO answers 501 and the caller (a future step) owns response handling.
export async function notifyJoinedServers(
  env: Env,
  userId: string,
  msg: ServerInternalMsg,
): Promise<void> {
  const rows = await env.DB.prepare("SELECT server_id FROM memberships WHERE user_id = ?")
    .bind(userId)
    .all<{ server_id: string }>();
  const body = JSON.stringify(msg);
  await Promise.all(
    rows.results.map((row) => {
      const stub = env.SERVER_ROOM.get(env.SERVER_ROOM.idFromName(row.server_id));
      return stub.fetch("https://do.internal/internal/member-update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
    }),
  );
}
