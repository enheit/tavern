import { useCallback, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ErrorCode, PatchSoundRequest, Sound } from "@tavern/shared";
import { ApiErrorBody, Sound as SoundSchema, SoundsResponse } from "@tavern/shared";
import { ApiError, apiClient } from "@/lib/apiClient";
import { authTransport } from "@/lib/authTransport";
import { connectRoom } from "@/lib/wsClient";

// FR-34/35/37 soundboard data hook: TanStack Query over the list GET, invalidated on the DO's
// `sound.updated` broadcast (any client's create/patch/delete), plus upload/patch/delete mutations.
// UI (SoundboardPanel) renders; this hook owns the I/O (§9.2).
export interface UseSounds {
  sounds: Sound[];
  isLoading: boolean;
  uploadSound(input: { file: File; name: string; durationMs: number }): Promise<Sound>;
  patchSound(soundId: string, patch: PatchSoundRequest): Promise<Sound>;
  deleteSound(soundId: string): Promise<void>;
  // FR-36: broadcast a play to every voice member (the DO rate-limits + records + fans out).
  sendPlay(soundId: string): void;
}

// FR-37 live badge: bump the played sound's count IN PLACE (no reorder — reordering happens only on
// the sound.updated refetch, which re-sorts by playCount). Returns a NEW response so React Query
// notifies subscribers.
function bumpPlayCount(
  prev: SoundsResponse | undefined,
  soundId: string,
): SoundsResponse | undefined {
  if (prev === undefined) return prev;
  return {
    sounds: prev.sounds.map((s) => (s.id === soundId ? { ...s, playCount: s.playCount + 1 } : s)),
  };
}

const API_BASE: string = import.meta.env.VITE_API_URL ?? "";

function soundsKey(serverId: string): readonly [string, string] {
  return ["sounds", serverId];
}

// The `{ sound: Sound }` envelope returned by POST/PATCH, validated structurally (the apiClient parser
// contract is `safeParse`) so no schema is added to the frozen shared api.ts.
function isEnvelope(value: unknown): value is { sound: unknown } {
  return typeof value === "object" && value !== null && "sound" in value;
}
const soundEnvelope = {
  safeParse(data: unknown): { success: true; data: { sound: Sound } } | { success: false } {
    if (!isEnvelope(data)) return { success: false };
    const parsed = SoundSchema.safeParse(data.sound);
    return parsed.success ? { success: true, data: { sound: parsed.data } } : { success: false };
  },
};

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
  const query = useQuery({
    queryKey: soundsKey(serverId),
    queryFn: () => apiClient.get(`/api/servers/${serverId}/sounds`, SoundsResponse),
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
      queryClient.setQueryData<SoundsResponse>(soundsKey(serverId), (prev) =>
        bumpPlayCount(prev, msg.soundId),
      );
    });
  }, [serverId, queryClient]);

  const uploadMutation = useMutation({
    mutationFn: async (input: { file: File; name: string; durationMs: number }): Promise<Sound> => {
      const form = new FormData();
      form.append("file", input.file);
      form.append("name", input.name);
      form.append("durationMs", String(input.durationMs));
      const res = await apiClient.upload(`/api/servers/${serverId}/sounds`, soundEnvelope, form);
      return res.sound;
    },
    onSuccess: invalidate,
  });

  const patchMutation = useMutation({
    mutationFn: async (input: { soundId: string; patch: PatchSoundRequest }): Promise<Sound> => {
      const res = await apiClient.patch(
        `/api/servers/${serverId}/sounds/${input.soundId}`,
        soundEnvelope,
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
    (input: { file: File; name: string; durationMs: number }) => uploadMutation.mutateAsync(input),
    [uploadMutation],
  );
  const patchSound = useCallback(
    (soundId: string, patch: PatchSoundRequest) => patchMutation.mutateAsync({ soundId, patch }),
    [patchMutation],
  );
  const deleteSound = useCallback(
    (soundId: string) => deleteMutation.mutateAsync(soundId),
    [deleteMutation],
  );

  // FR-36: pressing a sound broadcasts `sound.play`; every in-voice client (this one included) plays it
  // on the resulting `sound.played` receipt. Requires an open socket — a closed socket drops the press.
  const sendPlay = useCallback(
    (soundId: string): void => {
      try {
        connectRoom(serverId).send({ t: "sound.play", soundId });
      } catch {
        // WS not open — the press is dropped (a play needs a live socket).
      }
    },
    [serverId],
  );

  return {
    sounds: query.data?.sounds ?? [],
    isLoading: query.isLoading,
    uploadSound,
    patchSound,
    deleteSound,
    sendPlay,
  };
}
