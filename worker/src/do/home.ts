import { TavernHomeResponse } from "@tavern/shared";
import type { TavernHomeResponse as TavernHomeResponseType } from "@tavern/shared";
import type { HangoutsModule } from "./hangouts";
import type { PointsModule } from "./points";
import type { RecordingsModule } from "./recordings";
import { listScreenshots } from "./screenshots";
import { listSounds } from "./soundboard";

// A bounded projection over authoritative domain tables. Media creation is not copied into a generic
// JSON event store, so deleting a screenshot/sound/recording also removes it from Home immediately.
export function homeSnapshot(input: {
  sql: SqlStorage;
  hangouts: HangoutsModule;
  points: PointsModule;
  memberIds: readonly string[];
  now: number;
  recordings: RecordingsModule;
}): TavernHomeResponseType {
  const screenshots = listScreenshots(input.sql);
  const recordings = input.recordings.list();
  const sounds = listSounds(input.sql).toSorted((a, b) => b.createdAt - a.createdAt);
  const recentHangouts = input.hangouts.recent();

  return TavernHomeResponse.parse({
    recentHangouts,
    pointLeaderboard: input.points.leaderboard(input.memberIds, input.now),
    latestScreenshot: screenshots[0] ?? null,
    latestRecording: recordings[0] ?? null,
    latestSound: sounds[0] ?? null,
  });
}
