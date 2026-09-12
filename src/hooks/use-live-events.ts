import { useCallback, useEffect, useRef, useState } from "react";
import { liveEventsUrl } from "../api/client";
import { demoMode } from "../demo/mode";

/** A connected stream is current only after missed workspace changes have been reconciled. */
export function useLiveEvents({
  active,
  projectId,
  ideasLoaded,
  refreshBoard,
  refreshIdeas,
}: {
  active: boolean;
  projectId: string | undefined;
  ideasLoaded: boolean;
  refreshBoard: () => Promise<void>;
  refreshIdeas: () => Promise<void>;
}): { online: ReadonlySet<string>; connected: boolean; isCurrent: () => boolean } {
  const [online, setOnline] = useState<ReadonlySet<string>>(() => new Set());
  const [connected, setConnected] = useState(true);

  const current = useRef(true);
  const isCurrent = useCallback(() => current.current, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: projectId reconnects the stream when the selected project changes
  useEffect(() => {
    // Cursor writes must see invalidation before React commits the next render.
    const updateConnected = (value: boolean) => {
      current.current = value;
      setConnected(value);
    };
    if (demoMode || !active || typeof EventSource === "undefined") {
      updateConnected(true);
      return;
    }
    const source = new EventSource(liveEventsUrl());
    let alive = true;
    let opened = false;
    let pendingWork = false;
    let pendingIdeas = false;
    let refreshing = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 250;
    updateConnected(false);

    const flush = async () => {
      if (!alive || !opened || refreshing) return;
      clearTimeout(retry);
      refreshing = true;
      try {
        while (alive && opened && (pendingWork || pendingIdeas)) {
          const work = pendingWork;
          const ideas = pendingIdeas;
          pendingWork = false;
          pendingIdeas = false;
          try {
            await Promise.all([
              work ? refreshBoard() : Promise.resolve(),
              ideas && ideasLoaded ? refreshIdeas() : Promise.resolve(),
            ]);
          } catch {
            if (!alive) return;
            pendingWork ||= work;
            pendingIdeas ||= ideas;
            updateConnected(false);
            retry = setTimeout(() => void flush(), retryDelay);
            retryDelay = Math.min(retryDelay * 2, 5000);
            return;
          }
        }
        if (alive && opened) {
          retryDelay = 250;
          updateConnected(true);
        }
      } finally {
        refreshing = false;
      }
    };
    const reconnect = () => {
      opened = true;
      pendingWork = true;
      pendingIdeas = true;
      updateConnected(false);
      void flush();
    };
    const disconnected = () => {
      opened = false;
      updateConnected(false);
      setOnline(new Set());
      clearTimeout(retry);
    };
    const workspace = (event: Event) => {
      try {
        const scope = JSON.parse((event as MessageEvent<string>).data) as { scope?: string };
        pendingWork ||= scope.scope === "work" || scope.scope === "both";
        pendingIdeas ||= scope.scope === "ideas" || scope.scope === "both";
        if (pendingWork || pendingIdeas) {
          updateConnected(false);
          void flush();
        }
      } catch {
        // A malformed message cannot invalidate the connection itself.
      }
    };
    const presence = (event: Event) => {
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as { online?: unknown };
        if (Array.isArray(payload.online)) setOnline(new Set(payload.online.map(String)));
      } catch {
        // Keep listening after a malformed presence message.
      }
    };
    source.addEventListener("open", reconnect);
    source.addEventListener("error", disconnected);
    source.addEventListener("workspace", workspace);
    source.addEventListener("presence", presence);
    return () => {
      alive = false;
      current.current = false;
      clearTimeout(retry);
      source.removeEventListener("open", reconnect);
      source.removeEventListener("error", disconnected);
      source.removeEventListener("workspace", workspace);
      source.removeEventListener("presence", presence);
      source.close();
      setOnline(new Set());
    };
  }, [active, ideasLoaded, projectId, refreshBoard, refreshIdeas]);
  return { online, connected, isCurrent };
}
