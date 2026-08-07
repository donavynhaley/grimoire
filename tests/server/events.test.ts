import { describe, expect, it } from "vitest";
import { bootstrap, startTestServer } from "./test-server";

/** Reads one complete Server-Sent Events message at a time, across chunk boundaries. */
function eventStream(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const next = async (): Promise<string> => {
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary >= 0) {
        const message = buffer.slice(0, boundary + 2);
        buffer = buffer.slice(boundary + 2);
        return message;
      }
      const chunk = await reader.read();
      if (chunk.done) throw new Error("The event stream closed before the next message");
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };

  return {
    cancel: () => reader.cancel(),
    next,
    async nextNamed(name: string): Promise<string> {
      for (;;) {
        const message = await next();
        if (message.includes(`event: ${name}`)) return message;
      }
    },
    async quietFor(milliseconds: number): Promise<"event" | "quiet"> {
      return Promise.race([
        next().then(() => "event" as const),
        new Promise<"quiet">((resolve) => setTimeout(() => resolve("quiet"), milliseconds)),
      ]);
    },
  };
}

function payloadOf(message: string): Record<string, unknown> {
  const line = message.split("\n").find((value) => value.startsWith("data: "));
  return JSON.parse(line!.slice("data: ".length)) as Record<string, unknown>;
}

describe("live project events", () => {
  it("streams card changes to other authenticated clients and excludes the writer", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    const listenerResponse = await server.events("listener");
    const listener = eventStream(listenerResponse.body!);
    const writerResponse = await server.events("writer");
    const writer = eventStream(writerResponse.body!);

    expect(listenerResponse.status).toBe(200);
    expect(listenerResponse.headers.get("content-type")).toContain("text/event-stream");
    expect(await listener.next()).toContain(": connected");
    expect(await writer.next()).toContain(": connected");
    // Both streams belong to the owner, so presence reports one person rather than two.
    expect(payloadOf(await writer.nextNamed("presence")).online).toHaveLength(1);

    await server.request("/api/cards", {
      method: "POST",
      headers: { "x-grimoire-client-id": "writer" },
      body: JSON.stringify({ title: "Synchronize the ritual table" }),
    });

    const event = await listener.nextNamed("workspace");
    expect(event).toContain('data: {"scope":"work"}');
    expect(await writer.quietFor(30)).toBe("quiet");
    await listener.cancel();
    await writer.cancel();
  });

  it("announces who is present and who has left", async () => {
    const server = await startTestServer();
    await bootstrap(server);
    const ownerCookie = server.cookie();
    const invite = await server.request<{ code: string }>("/api/invites", {
      method: "POST",
      body: JSON.stringify({}),
    });
    // Registering switches the stored session cookie to the new member.
    await server.request("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        name: "Maren",
        email: "maren@example.com",
        password: "a long enough password",
        inviteCode: invite.body.code,
      }),
    });
    const memberCookie = server.cookie();

    const ownerStream = eventStream((await server.events("owner", ownerCookie)).body!);
    expect(await ownerStream.next()).toContain(": connected");
    expect(payloadOf(await ownerStream.nextNamed("presence")).online).toHaveLength(1);

    const memberResponse = await server.events("member", memberCookie);
    const memberStream = eventStream(memberResponse.body!);
    expect(payloadOf(await ownerStream.nextNamed("presence")).online).toHaveLength(2);

    await memberStream.cancel();
    expect(payloadOf(await ownerStream.nextNamed("presence")).online).toHaveLength(1);
    await ownerStream.cancel();
  });
});
