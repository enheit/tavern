import {
  VOICE_AVATAR_EYE_COLORS,
  VOICE_AVATAR_FACIAL_HAIR_STYLES,
  VOICE_AVATAR_GLASSES_STYLES,
  VOICE_AVATAR_HAIR_COLORS,
  VOICE_AVATAR_HAIR_STYLES,
  VOICE_AVATAR_OUTFIT_COLORS,
  VOICE_AVATAR_SKIN_TONES,
} from "@tavern/shared";
import type {
  VoiceAvatarConfig,
  VoiceAvatarEyeColor,
  VoiceAvatarFacialHairStyle,
  VoiceAvatarGlassesStyle,
  VoiceAvatarHairColor,
  VoiceAvatarHairStyle,
} from "@tavern/shared";
import { AudioLinesIcon, RotateCcwIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  automaticVoiceAvatarConfig,
  browserSupportsVoiceAvatarWebGL,
  createVoiceAvatarStage,
  VOICE_AVATAR_EYE_HEX,
  VOICE_AVATAR_HAIR_HEX,
  VOICE_AVATAR_SKIN_HEX,
} from "@/features/home/voiceAvatarScene";
import { cn } from "@/lib/utils";
import { useReducedMotion } from "@/lib/useReducedMotion";
import { m } from "@/paraglide/messages.js";

type RendererState = "loading" | "ready" | "fallback";

export function VoiceAvatarEditor({
  userId,
  profileColor,
  value,
  onChange,
}: {
  userId: string;
  profileColor: string;
  value: VoiceAvatarConfig | null;
  onChange: (value: VoiceAvatarConfig | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [rendererState, setRendererState] = useState<RendererState>("loading");
  const [previewSpeaking, setPreviewSpeaking] = useState(true);
  const speakingRef = useRef(previewSpeaking);
  speakingRef.current = previewSpeaking;
  const reducedMotion = useReducedMotion();
  const resolved = useMemo(
    () => value ?? automaticVoiceAvatarConfig(userId, profileColor),
    [profileColor, userId, value],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    if (!browserSupportsVoiceAvatarWebGL()) {
      setRendererState("fallback");
      return;
    }

    let cancelled = false;
    let frameId: number | null = null;
    let observer: ResizeObserver | null = null;
    let disposeStage: (() => void) | null = null;
    setRendererState("loading");

    const start = async (): Promise<void> => {
      const three = await import("three");
      if (cancelled) return;
      const stage = createVoiceAvatarStage(three, canvas, [
        { userId, color: profileColor, muted: false, voiceAvatar: resolved },
      ]);
      disposeStage = () => stage.dispose();
      if (cancelled) {
        stage.dispose();
        return;
      }
      const readPreviewLevel = (_avatarUserId: string, timeMs: number): number =>
        speakingRef.current ? 0.42 + (Math.sin(timeMs * 0.012) + 1) * 0.18 : 0;
      const resize = (): void => {
        const rect = canvas.getBoundingClientRect();
        stage.resize(rect.width, rect.height);
        stage.render(performance.now(), !reducedMotion, readPreviewLevel);
      };
      observer = new ResizeObserver(resize);
      observer.observe(canvas);
      resize();
      setRendererState("ready");

      if (!reducedMotion) {
        const frame = (time: number): void => {
          stage.render(time, true, readPreviewLevel);
          frameId = requestAnimationFrame(frame);
        };
        frameId = requestAnimationFrame(frame);
      }
    };

    void start().catch((error: unknown) => {
      if (cancelled) return;
      console.error("Voice avatar preview renderer failed", error);
      setRendererState("fallback");
    });

    return () => {
      cancelled = true;
      if (frameId !== null) cancelAnimationFrame(frameId);
      observer?.disconnect();
      disposeStage?.();
    };
  }, [profileColor, reducedMotion, resolved, userId]);

  const update = <Key extends keyof VoiceAvatarConfig>(
    key: Key,
    next: VoiceAvatarConfig[Key],
  ): void => onChange({ ...resolved, [key]: next });

  const hairStyleLabels: Record<VoiceAvatarHairStyle, string> = {
    short: m.voice_avatar_hair_short(),
    spiked: m.voice_avatar_hair_spiked(),
    curly: m.voice_avatar_hair_curly(),
    bun: m.voice_avatar_hair_bun(),
    bald: m.voice_avatar_hair_bald(),
    buzz: m.voice_avatar_hair_buzz(),
    wavy: m.voice_avatar_hair_wavy(),
    coily: m.voice_avatar_hair_coily(),
    locs: m.voice_avatar_hair_locs(),
    ponytail: m.voice_avatar_hair_ponytail(),
  };
  const hairColorLabels: Record<VoiceAvatarHairColor, string> = {
    black: m.voice_avatar_color_black(),
    "dark-brown": m.voice_avatar_color_dark_brown(),
    brown: m.voice_avatar_color_brown(),
    chestnut: m.voice_avatar_color_chestnut(),
    auburn: m.voice_avatar_color_auburn(),
    ginger: m.voice_avatar_color_ginger(),
    "golden-brown": m.voice_avatar_color_golden_brown(),
    blonde: m.voice_avatar_color_blonde(),
    platinum: m.voice_avatar_color_platinum(),
    gray: m.voice_avatar_color_gray(),
    white: m.voice_avatar_color_white(),
    violet: m.voice_avatar_color_violet(),
  };
  const eyeColorLabels: Record<VoiceAvatarEyeColor, string> = {
    "dark-brown": m.voice_avatar_eye_dark_brown(),
    brown: m.voice_avatar_eye_brown(),
    hazel: m.voice_avatar_eye_hazel(),
    amber: m.voice_avatar_eye_amber(),
    green: m.voice_avatar_eye_green(),
    blue: m.voice_avatar_eye_blue(),
    gray: m.voice_avatar_eye_gray(),
  };
  const glassesStyleLabels: Record<VoiceAvatarGlassesStyle, string> = {
    none: m.voice_avatar_none(),
    round: m.voice_avatar_glasses_round(),
    square: m.voice_avatar_glasses_square(),
    aviator: m.voice_avatar_glasses_aviator(),
    sunglasses: m.voice_avatar_glasses_sunglasses(),
  };
  const facialHairStyleLabels: Record<VoiceAvatarFacialHairStyle, string> = {
    none: m.voice_avatar_none(),
    stubble: m.voice_avatar_facial_hair_stubble(),
    mustache: m.voice_avatar_facial_hair_mustache(),
    goatee: m.voice_avatar_facial_hair_goatee(),
    "short-beard": m.voice_avatar_facial_hair_short_beard(),
    "full-beard": m.voice_avatar_facial_hair_full_beard(),
  };

  return (
    <fieldset data-testid="voice-avatar-editor" className="rounded-xl border p-4">
      <legend className="px-1 text-sm font-semibold">{m.voice_avatar_title()}</legend>
      <p className="mb-4 text-xs text-muted-foreground">{m.voice_avatar_description()}</p>

      <div className="grid gap-5 sm:grid-cols-[minmax(190px,0.8fr)_minmax(0,1.2fr)]">
        <div>
          <div
            data-testid="voice-avatar-preview"
            data-renderer={rendererState}
            className="relative h-64 overflow-hidden rounded-xl border bg-gradient-to-b from-muted/50 to-background"
          >
            {rendererState === "fallback" ? (
              <div className="flex size-full flex-col items-center justify-center gap-2 px-4 text-center text-xs text-muted-foreground">
                <AudioLinesIcon className="size-8 text-violet-500" />
                {m.voice_avatar_webgl_unavailable()}
              </div>
            ) : null}
            <canvas
              ref={canvasRef}
              aria-hidden={true}
              className={cn(
                "absolute inset-0 size-full transition-opacity",
                rendererState === "ready" ? "opacity-100" : "opacity-0",
              )}
            />
          </div>
          <label className="mt-3 flex items-center justify-between gap-3 text-xs">
            <span>{m.voice_avatar_preview_speaking()}</span>
            <Switch
              size="sm"
              checked={previewSpeaking && !reducedMotion}
              disabled={reducedMotion}
              data-testid="voice-avatar-preview-speaking"
              onCheckedChange={setPreviewSpeaking}
            />
          </label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="voice-avatar-use-automatic"
            className="mt-3 w-full"
            disabled={value === null}
            onClick={() => onChange(null)}
          >
            <RotateCcwIcon />
            {m.voice_avatar_use_automatic()}
          </Button>
        </div>

        <div className="flex flex-col gap-4">
          <AvatarSwatches
            label={m.voice_avatar_skin_tone()}
            values={VOICE_AVATAR_SKIN_TONES}
            selected={resolved.skinTone}
            colorFor={(tone) => VOICE_AVATAR_SKIN_HEX[tone]}
            optionLabel={(_tone, index) => m.voice_avatar_skin_option({ number: index + 1 })}
            testPrefix="voice-avatar-skin"
            onSelect={(skinTone) => update("skinTone", skinTone)}
          />
          <AvatarSwatches
            label={m.voice_avatar_hair_color()}
            values={VOICE_AVATAR_HAIR_COLORS}
            selected={resolved.hairColor}
            colorFor={(color) => VOICE_AVATAR_HAIR_HEX[color]}
            optionLabel={(color) => hairColorLabels[color]}
            testPrefix="voice-avatar-hair-color"
            onSelect={(hairColor) => update("hairColor", hairColor)}
          />

          <ChoiceGrid
            label={m.voice_avatar_hair_style()}
            values={VOICE_AVATAR_HAIR_STYLES}
            selected={resolved.hairStyle}
            labelFor={(hairStyle) => hairStyleLabels[hairStyle]}
            testPrefix="voice-avatar-hair-style"
            onSelect={(hairStyle) => update("hairStyle", hairStyle)}
          />

          <AvatarSwatches
            label={m.voice_avatar_eye_color()}
            values={VOICE_AVATAR_EYE_COLORS}
            selected={resolved.eyeColor}
            colorFor={(color) => VOICE_AVATAR_EYE_HEX[color]}
            optionLabel={(color) => eyeColorLabels[color]}
            testPrefix="voice-avatar-eye-color"
            onSelect={(eyeColor) => update("eyeColor", eyeColor)}
          />

          <ChoiceGrid
            label={m.voice_avatar_glasses()}
            values={VOICE_AVATAR_GLASSES_STYLES}
            selected={resolved.glassesStyle}
            labelFor={(glassesStyle) => glassesStyleLabels[glassesStyle]}
            testPrefix="voice-avatar-glasses"
            onSelect={(glassesStyle) => update("glassesStyle", glassesStyle)}
          />

          <ChoiceGrid
            label={m.voice_avatar_facial_hair()}
            values={VOICE_AVATAR_FACIAL_HAIR_STYLES}
            selected={resolved.facialHairStyle}
            labelFor={(facialHairStyle) => facialHairStyleLabels[facialHairStyle]}
            testPrefix="voice-avatar-facial-hair"
            onSelect={(facialHairStyle) => update("facialHairStyle", facialHairStyle)}
          />

          <AvatarSwatches
            label={m.voice_avatar_outfit_color()}
            values={VOICE_AVATAR_OUTFIT_COLORS}
            selected={resolved.outfitColor}
            colorFor={(color) => color}
            optionLabel={(_color, index) => m.voice_avatar_outfit_option({ number: index + 1 })}
            testPrefix="voice-avatar-outfit"
            onSelect={(outfitColor) => update("outfitColor", outfitColor)}
          />
        </div>
      </div>
    </fieldset>
  );
}

function AvatarSwatches<Value extends string>({
  label,
  values,
  selected,
  colorFor,
  optionLabel,
  testPrefix,
  onSelect,
}: {
  label: string;
  values: readonly Value[];
  selected: Value;
  colorFor: (value: Value) => string;
  optionLabel: (value: Value, index: number) => string;
  testPrefix: string;
  onSelect: (value: Value) => void;
}) {
  return (
    <div>
      <p className="mb-2 text-xs font-medium">{label}</p>
      <div className="flex flex-wrap gap-2">
        {values.map((option, index) => {
          const accessibleLabel = optionLabel(option, index);
          return (
            <button
              key={option}
              type="button"
              title={accessibleLabel}
              aria-label={accessibleLabel}
              aria-pressed={selected === option}
              data-testid={`${testPrefix}-${option}`}
              onClick={() => onSelect(option)}
              style={{ backgroundColor: colorFor(option) }}
              className={cn(
                "size-7 rounded-full border border-foreground/15",
                selected === option &&
                  "ring-2 ring-violet-500 ring-offset-2 ring-offset-background",
              )}
            />
          );
        })}
      </div>
    </div>
  );
}

function ChoiceGrid<Value extends string>({
  label,
  values,
  selected,
  labelFor,
  testPrefix,
  onSelect,
}: {
  label: string;
  values: readonly Value[];
  selected: Value;
  labelFor: (value: Value) => string;
  testPrefix: string;
  onSelect: (value: Value) => void;
}) {
  return (
    <div>
      <p className="mb-2 text-xs font-medium">{label}</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {values.map((option) => (
          <button
            key={option}
            type="button"
            data-testid={`${testPrefix}-${option}`}
            aria-pressed={selected === option}
            className={cn(
              "rounded-lg border px-2 py-2 text-xs transition-colors hover:bg-muted",
              selected === option && "border-violet-500 bg-violet-500/10",
            )}
            onClick={() => onSelect(option)}
          >
            {labelFor(option)}
          </button>
        ))}
      </div>
    </div>
  );
}
