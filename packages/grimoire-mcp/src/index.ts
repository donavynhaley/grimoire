#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GrimoireClient } from "./client.js";
import { createServer } from "./server.js";

/**
 * Entry point for the stdio transport.
 *
 * The client runs this process and talks to it over stdin and stdout, which means nothing new
 * is exposed on the network and the credential stays in the environment of the machine that
 * holds it. Everything this process does, it does over Grimoire's ordinary HTTP API.
 */

const url = process.env.GRIMOIRE_URL;
const token = process.env.GRIMOIRE_TOKEN;

if (!token) {
  // stdout belongs to the protocol, so anything a person needs to read goes to stderr.
  console.error(
    "GRIMOIRE_TOKEN is not set.\n\n" +
      "Create one in Grimoire under Project settings -> Agent access, then set:\n" +
      "  GRIMOIRE_URL=https://grimoire.example.com\n" +
      "  GRIMOIRE_TOKEN=grim_...\n",
  );
  process.exit(1);
}

if (!url) {
  console.error("GRIMOIRE_URL is not set. Point it at your Grimoire instance, e.g. http://127.0.0.1:8080\n");
  process.exit(1);
}

const client = new GrimoireClient({
  baseUrl: url,
  token,
  projectId: process.env.GRIMOIRE_PROJECT,
});

// The credential's scope decides which tools exist at all: a read-only agent handed the
// write tools would only ever discover its limits by being refused. If the lookup itself
// fails - server down, token already revoked - the full surface is registered and the
// first call carries the real explanation, which beats dying before the client connects.
const scope = await client
  .session()
  .then((session) => session.agent?.scope)
  .catch(() => undefined);

const server = createServer(client, { scope });
const transport = new StdioServerTransport();

await server.connect(transport);

/** A clean exit so the client does not have to kill the process. */
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.close().finally(() => process.exit(0));
  });
}
