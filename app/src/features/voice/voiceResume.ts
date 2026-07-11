import { getWebcamController } from "@/features/streams/useWebcam";
import { connectRoom } from "@/lib/wsClient";
import { useServersStore } from "@/stores/servers";
import { getVoiceController } from "./voiceController";
import { clearVoiceSession, loadVoiceSession, updateVoiceSession } from "./voiceSession";

// How long to wait for the voice server's socket before giving up on THIS page load. The blob is
// kept on timeout (the sockets keep their own reconnect loop), so a later refresh can still resume.
const WS_OPEN_DEADLINE_MS = 15_000;

// StrictMode double-mounts the BootGate effect and `restart` can re-enter `ready` — resume must
// only ever run once per page load (a refresh gets a fresh module registry, so a fresh chance).
let ran = false;

// Refresh auto-resume: rejoin the persisted voice channel (voiceSession.ts, per-tab) and restore
// the mute/deafen flags + webcam. Screen share is deliberately NOT resumed — getDisplayMedia
// requires a user gesture on the web, so a share can never restart itself after a reload.
// Runs after boot `ready`: session + server list are in and the ACTIVE server's socket is open.
export async function resumeVoiceSession(): Promise<void> {
  if (ran) return;
  ran = true;
  const session = loadVoiceSession();
  if (session === null) return;

  // Membership may have changed while the blob sat in the tab (kicked, or left the server on
  // another device) — a stale blob must not spin on a server we can no longer join.
  const member = useServersStore.getState().servers.some((s) => s.id === session.serverId);
  if (!member) {
    clearVoiceSession();
    return;
  }

  // voice.join sends on the room socket and `send` THROWS unless status is "open" — boot `ready`
  // only awaited the ACTIVE server's hello.ok, and the voice session may live on another server.
  const opened = await waitForOpen(session.serverId);
  if (!opened) return;

  const controller = getVoiceController();
  try {
    await controller.join(session.serverId);
  } catch {
    // Failed rejoin (or VoiceElsewhereError from a faster manual join) — don't loop on a broken
    // resume. Only clear OUR blob: a manual join that already won may have written a fresh one.
    if (loadVoiceSession()?.serverId === session.serverId) clearVoiceSession();
    return;
  }

  // Same restore order as the WS-reconnect path (§6.2): deafen before mute.
  if (session.deafened) controller.setDeafened(true);
  if (session.muted) controller.setMuted(true);

  if (session.camOn) {
    try {
      await getWebcamController().start();
    } catch {
      // Camera unplugged/denied since the reload — resume voice-only and stop re-trying.
      updateVoiceSession({ camOn: false });
    }
  }
}

function waitForOpen(serverId: string): Promise<boolean> {
  const conn = connectRoom(serverId);
  if (conn.status === "open") return Promise.resolve(true);
  return new Promise((resolve) => {
    let deadline: ReturnType<typeof setTimeout> | null = null;
    const off = conn.on("hello.ok", () => {
      off();
      if (deadline !== null) clearTimeout(deadline);
      resolve(true);
    });
    deadline = setTimeout(() => {
      off();
      resolve(false);
    }, WS_OPEN_DEADLINE_MS);
  });
}
