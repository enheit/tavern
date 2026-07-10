import { app } from "electron";
import { focusMainWindow } from "./window";

// Returns false when another instance already holds the lock (caller should quit). Skipped entirely
// in E2E mode, where two instances (distinct userData dirs) are launched on purpose (§10).
export function acquireSingleInstanceLock(): boolean {
  if (process.env.TAVERN_E2E === "1") return true;
  if (!app.requestSingleInstanceLock()) return false;
  app.on("second-instance", () => {
    focusMainWindow();
  });
  return true;
}
