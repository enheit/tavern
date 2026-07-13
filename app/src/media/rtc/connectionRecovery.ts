export type ConnectionRecoveryReason = "failed" | "reconnected";

// A WebRTC transport can recover from `disconnected` without ever entering `failed`. Cloudflare
// Realtime sessions may still be stale after that path, so the owner must rebuild the session once
// connectivity returns. Waiting for `connected` avoids trying to signal while the client is offline.
export function watchConnectionRecovery(
  pc: RTCPeerConnection,
  onRecoveryNeeded: (reason: ConnectionRecoveryReason) => void,
): void {
  let wasDisconnected = false;
  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "disconnected") {
      wasDisconnected = true;
      return;
    }
    if (pc.connectionState === "failed") {
      wasDisconnected = false;
      onRecoveryNeeded("failed");
      return;
    }
    if (pc.connectionState === "connected" && wasDisconnected) {
      wasDisconnected = false;
      onRecoveryNeeded("reconnected");
    }
  });
}
