import type {
  CreateServerRequest,
  ErrorCode,
  JoinServerRequest,
  ServerSummary,
} from "@tavern/shared";
import { ServerSummary as ServerSummarySchema } from "@tavern/shared";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { ApiError, apiClient } from "@/lib/apiClient";
import { connectRoom } from "@/lib/wsClient";
import { useServersStore } from "@/stores/servers";

// FR-08 / FR-09 server create + join. TanStack Query mutations POST the shared contracts; on success
// the returned ServerSummary is upserted into the servers store, a WS is opened for that server (A6),
// and the new server id resolves to the caller (which navigates to /s/:id). A server `ErrorCode`
// (e.g. wrong_password) surfaces via `error` and rejects the promise so the caller does not navigate;
// a transport failure rejects with a non-ApiError (caller shows the generic network message).
export interface UseServers {
  servers: ServerSummary[];
  activeServerId: string | null;
  createServer(input: CreateServerRequest): Promise<string>;
  joinServer(input: JoinServerRequest): Promise<string>;
  pending: boolean;
  error: ErrorCode | null;
}

export function useServers(): UseServers {
  const servers = useServersStore((s) => s.servers);
  const activeServerId = useServersStore((s) => s.activeServerId);
  const [error, setError] = useState<ErrorCode | null>(null);

  const createMutation = useMutation({
    mutationFn: (input: CreateServerRequest) =>
      apiClient.post("/api/servers", ServerSummarySchema, input),
  });
  const joinMutation = useMutation({
    mutationFn: (input: JoinServerRequest) =>
      apiClient.post("/api/servers/join", ServerSummarySchema, input),
  });

  // Upsert into the servers store (dedupe by id), open the per-server socket, return the id.
  const onSummary = useCallback((summary: ServerSummary): string => {
    const store = useServersStore.getState();
    store.setServers([...store.servers.filter((s) => s.id !== summary.id), summary]);
    connectRoom(summary.id);
    return summary.id;
  }, []);

  const run = useCallback(
    async (mutate: () => Promise<ServerSummary>): Promise<string> => {
      setError(null);
      try {
        return onSummary(await mutate());
      } catch (err) {
        if (err instanceof ApiError) setError(err.code);
        throw err;
      }
    },
    [onSummary],
  );

  const createServer = useCallback(
    (input: CreateServerRequest) => run(() => createMutation.mutateAsync(input)),
    [run, createMutation],
  );
  const joinServer = useCallback(
    (input: JoinServerRequest) => run(() => joinMutation.mutateAsync(input)),
    [run, joinMutation],
  );

  return {
    servers,
    activeServerId,
    createServer,
    joinServer,
    pending: createMutation.isPending || joinMutation.isPending,
    error,
  };
}
