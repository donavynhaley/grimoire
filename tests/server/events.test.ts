import { describe, expect, it } from "vitest";
import { bootstrap, startTestServer } from "./test-server";

describe("live project events", () => {
  it("streams card changes to other authenticated clients and excludes the writer", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    const listener = await server.events("listener");
    const reader = listener.body!.getReader();
    const writer = await server.events("writer");
    const writerReader = writer.body!.getReader();
    const decoder = new TextDecoder();

    expect(listener.status).toBe(200);
    expect(listener.headers.get("content-type")).toContain("text/event-stream");
    expect(decoder.decode((await reader.read()).value)).toContain(": connected");
    expect(decoder.decode((await writerReader.read()).value)).toContain(": connected");

    await server.request("/api/cards", {
      method: "POST",
      headers: { "x-grimoire-client-id": "writer" },
      body: JSON.stringify({ title: "Synchronize the ritual table" }),
    });

    const event = decoder.decode((await reader.read()).value);
    expect(event).toContain("event: workspace");
    expect(event).toContain('data: {"scope":"work"}');
    expect(await Promise.race([
      writerReader.read().then(() => "event"),
      new Promise<string>((resolve) => setTimeout(() => resolve("quiet"), 30)),
    ])).toBe("quiet");
    await reader.cancel();
    await writerReader.cancel();
  });
});
