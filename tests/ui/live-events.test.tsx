// @vitest-environment jsdom

import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { useAwayState } from "../../src/hooks/use-away-state";
import { useLiveEvents } from "../../src/hooks/use-live-events";
import { installUiHarness, routeFetch } from "../fixtures/ui";

installUiHarness();

class Stream extends EventTarget {
  static instances: Stream[] = [];
  constructor() {
    super();
    Stream.instances.push(this);
  }
  close() {}
}

function Session({ ideasLoaded, refresh }: { ideasLoaded: boolean; refresh: () => Promise<void> }) {
  const { connected, isCurrent } = useLiveEvents({
    active: true,
    projectId: "project",
    ideasLoaded,
    refreshBoard: refresh,
    refreshIdeas: refresh,
  });
  const { advanceSeen } = useAwayState(true, "project", isCurrent);
  // biome-ignore lint/correctness/useExhaustiveDependencies: loading ideas commits a new canonical revision, as in App
  useEffect(() => {
    if (connected) advanceSeen();
  }, [advanceSeen, connected, ideasLoaded]);
  return null;
}

async function connectedSession() {
  Stream.instances = [];
  vi.stubGlobal("EventSource", Stream);
  const { calls } = routeFetch({ routes: { "GET /api/away": () => new Promise(() => {}) } });
  const refresh = vi.fn(() => Promise.resolve());
  const view = render(<Session ideasLoaded={false} refresh={refresh} />);
  await act(async () => Stream.instances[0]!.dispatchEvent(new Event("open")));
  expect(calls.some((call) => call.url === "/api/seen")).toBe(true);
  calls.length = 0;
  return { ...view, calls, refresh };
}

describe("seen cursor during live reconciliation", () => {
  it("blocks a visibility advance immediately when the stream disconnects", async () => {
    const { calls } = await connectedSession();
    act(() => {
      Stream.instances[0]!.dispatchEvent(new Event("error"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(calls.filter((call) => call.url === "/api/seen")).toHaveLength(0);
  });

  it("blocks revision advances while restarting the stream to include ideas", async () => {
    const { calls, refresh, rerender } = await connectedSession();
    let release!: () => void;
    rerender(<Session ideasLoaded refresh={refresh} />);
    expect(Stream.instances).toHaveLength(2);
    expect(calls.filter((call) => call.url === "/api/seen")).toHaveLength(0);
    // Both canonical reads share one gate so neither can advance the cursor early.
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    refresh.mockImplementation(() => gate);
    await act(async () => Stream.instances[1]!.dispatchEvent(new Event("open")));
    expect(calls.filter((call) => call.url === "/api/seen")).toHaveLength(0);
    await act(async () => release());
    expect(calls.filter((call) => call.url === "/api/seen")).toHaveLength(1);
  });
});
