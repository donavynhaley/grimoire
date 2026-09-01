import { useEffect, useState } from "react";
import { ApiError, liveEventsUrl } from "../api/client";

/**
 * One Server-Sent Events stream per signed-in board, and the presence read off it.
 *
 * Events name what changed - work, ideas, or both - rather than carrying data, and nearby
 * events coalesce into one reload of canonical state. Watching a live change happen counts
 * as seeing it, so the flush advances the seen cursor; hidden tabs skip that inside
 * `advanceSeen` itself.
 */
export function useLiveEvents({
  active,
  projectId,
  ideasLoaded,
  refreshBoard,
  refreshIdeas,
  advanceSeen,
  onError,
}: {
  active: boolean;
  projectId: string | undefined;
  ideasLoaded: boolean;
  refreshBoard: () => Promise<void>;
  refreshIdeas: () => Promise<void>;
  advanceSeen: () => void;
  onError: (message: string) => void;
}): ReadonlySet<string> {
  const [online, setOnline] = useState<ReadonlySet<string>>(() => new Set());

  // biome-ignore lint/correctness/useExhaustiveDependencies: projectId is the trigger that reconnects the stream when the project changes; without it a switch would keep streaming the previous project's events
  useEffect(() => {
    if (!active || typeof EventSource === "undefined") return;
    const source = new EventSource(liveEventsUrl());
    let pendingWork = false;
    let pendingIdeas = false;
    let refreshing = false;

    const flush = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        while (pendingWork || pendingIdeas) {
          const work = pendingWork;
          const ideaGarden = pendingIdeas;
          pendingWork = false;
          pendingIdeas = false;
          await Promise.all([
            work ? refreshBoard() : Promise.resolve(),
            ideaGarden && ideasLoaded ? refreshIdeas() : Promise.resolve(),
          ]);
          advanceSeen();
        }
      } catch (value) {
        onError(value instanceof ApiError ? value.message : "Live changes could not be loaded");
      } finally {
        refreshing = false;
      }
    };

    const receiveWorkspaceChange = (event: Event) => {
      try {
        const scope = JSON.parse((event as MessageEvent<string>).data) as { scope?: string };
        pendingWork ||= scope.scope === "work" || scope.scope === "both";
        pendingIdeas ||= scope.scope === "ideas" || scope.scope === "both";
        void flush();
      } catch {
        // Ignore malformed stream messages and keep the connection alive.
      }
    };
    const receivePresence = (event: Event) => {
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as { online?: unknown };
        if (Array.isArray(payload.online)) setOnline(new Set(payload.online.map(String)));
      } catch {
        // Ignore malformed stream messages and keep the connection alive.
      }
    };

    source.addEventListener("workspace", receiveWorkspaceChange);
    source.addEventListener("presence", receivePresence);
    return () => {
      source.removeEventListener("workspace", receiveWorkspaceChange);
      source.removeEventListener("presence", receivePresence);
      source.close();
      setOnline(new Set());
    };
  }, [active, advanceSeen, ideasLoaded, onError, projectId, refreshBoard, refreshIdeas]);

  return online;
}
