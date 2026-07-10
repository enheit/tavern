import { CircleIcon } from "lucide-react";
import { useStore } from "zustand";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { connectRoom } from "@/lib/wsClient";
import { createRecordingUploadApi, R2MultipartSink, VoiceRecorder } from "@/media/recorder";
import type { RecorderState } from "@/media/recorder";
import { getVoiceController } from "@/features/voice/voiceController";
import { m } from "@/paraglide/messages.js";
import { roomStore } from "@/stores/room";
import { useSessionStore } from "@/stores/session";

// FR-25 record toggle + the red REC indicator. The recorder mixes the shared audio graph + the live
// mic (via the voice controller's seam) into a MediaRecorder, uploading R2 parts as it records. One
// active session per client; the module singleton lets the ControlsBar leave-flow stop it gracefully.

interface RecordingSession {
  serverId: string;
  recorder: VoiceRecorder;
  sink: R2MultipartSink;
}

let session: RecordingSession | null = null;

function onRecorderState(serverId: string, state: RecorderState): void {
  // A part gave up after ×3 retries: the sink already aborted the R2 multipart (the DO cancels the
  // row + drops the indicator). Tear down the local recorder so the mix is released.
  if (state !== "error") return;
  const current = session;
  if (current === null || current.serverId !== serverId) return;
  session = null;
  void current.recorder.stop().catch(() => undefined);
}

function beginRecording(serverId: string): void {
  if (session !== null) return;
  const inputs = getVoiceController().recorderInputs();
  if (inputs === null) return; // not fully in voice (no mic) → nothing to record
  try {
    // rec.start first: the DO registers the row + marks the active starter before the first part opens.
    connectRoom(serverId).send({ t: "rec.start" });
  } catch {
    return; // socket not open — cannot register the recording
  }
  const sink = new R2MultipartSink(createRecordingUploadApi(serverId), (state) =>
    onRecorderState(serverId, state),
  );
  const recorder = new VoiceRecorder({ graph: inputs.graph });
  session = { serverId, recorder, sink };
  recorder.start(inputs.localMic, sink);
}

// Stop-and-complete: flip the DO state inactive (WS), flush the tail part, then complete the upload.
// Exported so the ControlsBar runs it BEFORE voice.leave (graceful path — a bare leave would dirty-end
// the recording server-side and discard it).
export async function stopRecording(serverId: string): Promise<void> {
  const current = session;
  if (current === null || current.serverId !== serverId) return;
  session = null;
  try {
    connectRoom(serverId).send({ t: "rec.stop" });
  } catch {
    // Socket already gone — the DO's dirty-end path will cancel it; still flush what we can.
  }
  const { durationMs } = await current.recorder.stop();
  await current.sink.finish(durationMs);
}

export function RecordButton({ serverId, inVoice }: { serverId: string; inVoice: boolean }) {
  const recording = useStore(roomStore(serverId), (s) => s.recording);
  const selfId = useSessionStore((s) => s.profile?.userId ?? null);
  const members = useStore(roomStore(serverId), (s) => s.members);

  const active = recording.active;
  const ownedBySelf = active && recording.startedBy === selfId;
  const starter = members.find((mem) => mem.userId === recording.startedBy);

  const onClick = (): void => {
    if (ownedBySelf) void stopRecording(serverId);
    else if (!active) beginRecording(serverId);
  };

  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        data-testid="controls-record"
        aria-label={ownedBySelf ? m.voice_record_stop() : m.voice_record_start()}
        aria-pressed={ownedBySelf}
        // Enabled only in voice; while another member records (already_recording) it is inert.
        disabled={!inVoice || (active && !ownedBySelf)}
        className={cn(ownedBySelf && "text-destructive")}
        onClick={onClick}
      >
        <CircleIcon className={cn(ownedBySelf && "fill-current")} />
      </Button>
      {active && inVoice && (
        <span
          data-testid="rec-indicator"
          className="flex animate-pulse items-center gap-1 rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-semibold text-destructive"
        >
          <span className="size-2 rounded-full bg-destructive" aria-hidden={true} />
          {m.recording_indicator()}
          {starter !== undefined && <span className="font-normal">{starter.displayName}</span>}
        </span>
      )}
    </>
  );
}
