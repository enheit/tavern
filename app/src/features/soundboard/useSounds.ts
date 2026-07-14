import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { ErrorCode, PatchSoundRequest, Sound } from "@tavern/shared";
import { ApiErrorBody, SoundResponse, SoundsResponse } from "@tavern/shared";
import { ApiError, apiClient } from "@/lib/apiClient";
import { authTransport } from "@/lib/authTransport";
import { connectRoom } from "@/lib/wsClient";
import { getVoiceController } from "@/features/voice/voiceController";
import { useMediaStore } from "@/stores/media";

export interface SoundUploadInput {
  file: File;
  name: string;
  emoji: string;
  gain: number;
  durationMs: number;
  trimStartRatio: number;
  trimEndRatio: number;
}

export interface ActiveSoundPlay {
  token: number;
  durationMs: number;
}

// FR-34/35/37 soundboard data hook: TanStack Query over the list GET, invalidated on the DO's
// `sound.updated` broadcast (any client's create/patch/delete), plus upload/patch/delete mutations.
// UI (SoundboardPanel) renders; this hook owns the I/O (§9.2).
export interface UseSounds {
  sounds: Sound[];
  isLoading: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage(): Promise<unknown>;
  uploadSound(input: SoundUploadInput): Promise<Sound>;
  replaceSound(soundId: string, input: SoundUploadInput): Promise<Sound>;
  patchSound(soundId: string, patch: PatchSoundRequest): Promise<Sound>;
  deleteSound(soundId: string): Promise<void>;
  activateSound(sound: Sound): Promise<void>;
  stopSound(soundId: string): void;
  activePlays: Record<string, ActiveSoundPlay>;
}

// FR-37 live badge: bump the played sound's count IN PLACE (no reorder — reordering happens only on
// the sound.updated refetch, which re-sorts by playCount). Returns a NEW response so React Query
// notifies subscribers.
function bumpPlayCount(
  prev: { pages: SoundsResponse[]; pageParams: number[] } | undefined,
  soundId: string,
): { pages: SoundsResponse[]; pageParams: number[] } | undefined {
  if (prev === undefined) return prev;
  return {
    ...prev,
    pages: prev.pages.map((page) => ({
      ...page,
      sounds: page.sounds.map((s) => (s.id === soundId ? { ...s, playCount: s.playCount + 1 } : s)),
    })),
  };
}

const API_BASE: string = import.meta.env.VITE_API_URL ?? "";

function soundsKey(serverId: string): readonly [string, string] {
  return ["sounds", serverId];
}

function makeSoundForm(input: SoundUploadInput): FormData {
  const form = new FormData();
  form.append("file", input.file);
  form.append("name", input.name);
  form.append("emoji", input.emoji);
  form.append("gain", String(input.gain));
  form.append("durationMs", String(input.durationMs));
  form.append("trimStartRatio", String(input.trimStartRatio));
  form.append("trimEndRatio", String(input.trimEndRatio));
  return form;
}

// DELETE returns 204 (no body), which apiClient's JSON-parsing request cannot consume — so it uses a
// thin authed fetch here. Mirrors apiClient's transport (auth headers + set-auth-token capture + typed
// ErrorCode on failure).
async function deleteRequest(path: string): Promise<void> {
  const headers = await authTransport.getAuthHeaders();
  const res = await fetch(`${API_BASE}${path}`, {
    method: "DELETE",
    headers,
    credentials: "include",
  });
  await authTransport.storeFromResponse(res.headers);
  if (!res.ok) {
    let code: ErrorCode = "bad_message";
    try {
      const parsed = ApiErrorBody.safeParse(await res.json());
      if (parsed.success) code = parsed.data.error;
    } catch {
      // Non-JSON error body — keep the generic code.
    }
    throw new ApiError(code, res.status);
  }
}

export function useSounds(serverId: string): UseSounds {
  const queryClient = useQueryClient();
  const [activePlays, setActivePlays] = useState<Record<string, ActiveSoundPlay>>({});
  const playToken = useRef(0);
  const playTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const clearActivePlay = useCallback((soundId: string): void => {
    const timer = playTimers.current.get(soundId);
    if (timer !== undefined) clearTimeout(timer);
    playTimers.current.delete(soundId);
    setActivePlays((current) => {
      if (current[soundId] === undefined) return current;
      const next = { ...current };
      delete next[soundId];
      return next;
    });
  }, []);

  const startActivePlay = useCallback(
    (soundId: string, durationMs: number): void => {
      clearActivePlay(soundId);
      playToken.current += 1;
      const token = playToken.current;
      setActivePlays((current) => ({ ...current, [soundId]: { token, durationMs } }));
      playTimers.current.set(
        soundId,
        setTimeout(() => clearActivePlay(soundId), durationMs),
      );
    },
    [clearActivePlay],
  );

  useEffect(
    () => () => {
      for (const timer of playTimers.current.values()) clearTimeout(timer);
      playTimers.current.clear();
    },
    [],
  );
  const query = useInfiniteQuery({
    queryKey: soundsKey(serverId),
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      apiClient.get(`/api/servers/${serverId}/sounds?offset=${pageParam}&limit=30`, SoundsResponse),
    getNextPageParam: (lastPage, pages) =>
      lastPage.hasMore ? pages.reduce((total, page) => total + page.sounds.length, 0) : undefined,
  });

  const invalidate = useCallback((): void => {
    void queryClient.invalidateQueries({ queryKey: soundsKey(serverId) });
  }, [queryClient, serverId]);

  // Refetch on the DO's `sound.updated` broadcast (create/patch/delete from any member, S9.2).
  useEffect(() => {
    const conn = connectRoom(serverId);
    return conn.on("sound.updated", invalidate);
  }, [serverId, invalidate]);

  // FR-37: on a `sound.played` broadcast, bump the badge in place (no reorder). Playback is NOT wired
  // here — the voice controller plays the self-contained frame for every in-voice member, so a member
  // who never opened this panel still hears it (the old panel-scoped listener silently dropped audio
  // for them). The controller guards on inVoice && !deafened.
  useEffect(() => {
    const conn = connectRoom(serverId);
    return conn.on("sound.played", (msg) => {
      startActivePlay(msg.soundId, msg.trimEndMs - msg.trimStartMs);
      queryClient.setQueryData<{ pages: SoundsResponse[]; pageParams: number[] }>(
        soundsKey(serverId),
        (prev) => bumpPlayCount(prev, msg.soundId),
      );
    });
  }, [serverId, queryClient, startActivePlay]);

  useEffect(() => {
    const conn = connectRoom(serverId);
    return conn.on("sound.stopped", (message) => clearActivePlay(message.soundId));
  }, [serverId, clearActivePlay]);

  const uploadMutation = useMutation({
    mutationFn: async (input: SoundUploadInput): Promise<Sound> => {
      const res = await apiClient.upload(
        `/api/servers/${serverId}/sounds`,
        SoundResponse,
        makeSoundForm(input),
      );
      return res.sound;
    },
    onSuccess: invalidate,
  });

  const replaceMutation = useMutation({
    mutationFn: async (input: { soundId: string; upload: SoundUploadInput }): Promise<Sound> => {
      const res = await apiClient.uploadPut(
        `/api/servers/${serverId}/sounds/${input.soundId}/source`,
        SoundResponse,
        makeSoundForm(input.upload),
      );
      return res.sound;
    },
    onSuccess: invalidate,
  });

  const patchMutation = useMutation({
    mutationFn: async (input: { soundId: string; patch: PatchSoundRequest }): Promise<Sound> => {
      const res = await apiClient.patch(
        `/api/servers/${serverId}/sounds/${input.soundId}`,
        SoundResponse,
        input.patch,
      );
      return res.sound;
    },
    onSuccess: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: (soundId: string) => deleteRequest(`/api/servers/${serverId}/sounds/${soundId}`),
    onSuccess: invalidate,
  });

  const uploadSound = useCallback(
    (input: SoundUploadInput) => uploadMutation.mutateAsync(input),
    [uploadMutation],
  );
  const replaceSound = useCallback(
    (soundId: string, upload: SoundUploadInput) => replaceMutation.mutateAsync({ soundId, upload }),
    [replaceMutation],
  );
  const patchSound = useCallback(
    (soundId: string, patch: PatchSoundRequest) => patchMutation.mutateAsync({ soundId, patch }),
    [patchMutation],
  );
  const deleteSound = useCallback(
    (soundId: string) => deleteMutation.mutateAsync(soundId),
    [deleteMutation],
  );

  const activateSound = useCallback(
    async (sound: Sound): Promise<void> => {
      if (playTimers.current.has(sound.id)) return;
      const media = useMediaStore.getState();
      if (media.inVoiceServerId === serverId && media.voiceStatus === "joined") {
        connectRoom(serverId).send({ t: "sound.play", soundId: sound.id });
        return;
      }
      startActivePlay(sound.id, sound.trimEndMs - sound.trimStartMs);
      try {
        await getVoiceController().previewSoundboard(serverId, sound);
      } catch (error: unknown) {
        clearActivePlay(sound.id);
        throw error;
      }
    },
    [serverId, startActivePlay, clearActivePlay],
  );

  const stopSound = useCallback(
    (soundId: string): void => {
      const media = useMediaStore.getState();
      if (media.inVoiceServerId === serverId && media.voiceStatus === "joined") {
        connectRoom(serverId).send({ t: "sound.stop", soundId });
        return;
      }
      getVoiceController().stopSoundboardPreview(soundId);
      clearActivePlay(soundId);
    },
    [serverId, clearActivePlay],
  );

  return {
    sounds: useMemo(() => query.data?.pages.flatMap((page) => page.sounds) ?? [], [query.data]),
    isLoading: query.isLoading,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    fetchNextPage: query.fetchNextPage,
    uploadSound,
    replaceSound,
    patchSound,
    deleteSound,
    activateSound,
    stopSound,
    activePlays,
  };
}
