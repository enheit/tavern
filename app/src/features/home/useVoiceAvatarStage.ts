import { useEffect, useRef, useState } from "react";
import { readVoiceLevel } from "@/media/voiceLevelBus";
import { useReducedMotion } from "@/lib/useReducedMotion";
import {
  browserSupportsVoiceAvatarWebGL,
  createVoiceAvatarStage,
  type VoiceAvatarMember,
  type VoiceAvatarStage,
} from "./voiceAvatarScene";

export type VoiceAvatarRendererState = "loading" | "ready" | "fallback";

// Owns the shared WebGL lifecycle for both the Dashboard lounge and Stream participant tiles. The
// renderer receives semantic avatar recipes plus live voice levels; callers only own surrounding UI.
export function useVoiceAvatarStage({
  active,
  canvasRef,
  members,
}: {
  active: boolean;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  members: VoiceAvatarMember[];
}): VoiceAvatarRendererState {
  const stageRef = useRef<VoiceAvatarStage | null>(null);
  const [rendererState, setRendererState] = useState<VoiceAvatarRendererState>("loading");
  const reducedMotion = useReducedMotion();
  const sceneKey = members
    .map(
      (member) =>
        `${member.userId}:${member.color}:${member.muted ? 1 : 0}:${member.voiceAvatar === undefined ? "auto" : JSON.stringify(member.voiceAvatar)}`,
    )
    .join("|");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!active || canvas === null || members.length === 0) return;
    if (!browserSupportsVoiceAvatarWebGL()) {
      setRendererState("fallback");
      return;
    }

    let cancelled = false;
    let frameId: number | null = null;
    let observer: ResizeObserver | null = null;
    setRendererState("loading");

    const start = async (): Promise<void> => {
      const three = await import("three");
      if (cancelled) return;
      const stage = createVoiceAvatarStage(three, canvas, members);
      if (cancelled) {
        stage.dispose();
        return;
      }
      stageRef.current = stage;

      const resize = (): void => {
        const rect = canvas.getBoundingClientRect();
        stage.resize(rect.width, rect.height);
        stage.render(performance.now(), !reducedMotion, readVoiceLevel);
      };
      observer = new ResizeObserver(resize);
      observer.observe(canvas);
      resize();
      setRendererState("ready");

      if (!reducedMotion) {
        const frame = (time: number): void => {
          stage.render(time, true, readVoiceLevel);
          frameId = requestAnimationFrame(frame);
        };
        frameId = requestAnimationFrame(frame);
      }
    };

    void start().catch((error: unknown) => {
      if (cancelled) return;
      console.error("Voice avatar WebGL renderer failed; showing static avatar", error);
      setRendererState("fallback");
    });

    return () => {
      cancelled = true;
      if (frameId !== null) cancelAnimationFrame(frameId);
      observer?.disconnect();
      stageRef.current?.dispose();
      stageRef.current = null;
    };
  }, [active, canvasRef, members, reducedMotion, sceneKey]);

  return rendererState;
}
