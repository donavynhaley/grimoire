import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach } from "vitest";
import { createGrimoireServer } from "../../server/app";

type TestServer = {
  baseUrl: string;
  pagesDirectory: string;
  close: () => Promise<void>;
  /** The session cookie of the most recently authenticated request. */
  cookie: () => string;
  databasePath: string;
  events: (clientId: string, sessionCookie?: string) => Promise<Response>;
  fetchRaw: (path: string, init?: RequestInit) => Promise<Response>;
  request: <T>(path: string, init?: RequestInit) => Promise<{ response: Response; body: T }>;
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

type TestServerOptions = {
  /** Serves the built shell, which only production does, for link preview coverage. */
  staticDirectory?: string;
  /** Stands in for the GitHub API; the poll interval stays off so tests drive syncs by hand. */
  githubFetcher?: Parameters<typeof createGrimoireServer>[0]["githubFetcher"];
  /** Stands in for Discord, so a test can be the thing a recap is posted to. */
  discordPoster?: Parameters<typeof createGrimoireServer>[0]["discordPoster"];
};

export async function startTestServer(
  existingDirectory?: string,
  options: TestServerOptions = {},
): Promise<TestServer> {
  const directory = existingDirectory ?? mkdtempSync(join(tmpdir(), "grimoire-test-"));
  const databasePath = join(directory, "grimoire.sqlite");
  const app = createGrimoireServer({
    databasePath,
    production: options.staticDirectory !== undefined,
    staticDirectory: options.staticDirectory,
    githubPollMs: 0,
    githubFetcher: options.githubFetcher,
    discordPoster: options.discordPoster,
  });

  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let cookie = "";

  const close = async () => {
    app.closeEventStreams();
    if (app.server.listening) {
      await new Promise<void>((resolve, reject) => {
        app.server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    app.close();
    if (!existingDirectory) rmSync(directory, { recursive: true, force: true });
  };

  cleanups.push(close);

  return {
    baseUrl,
    pagesDirectory: join(directory, "pages"),
    close,
    cookie: () => cookie,
    databasePath,
    events(clientId: string, sessionCookie = cookie) {
      const headers = new Headers();
      if (sessionCookie) headers.set("cookie", sessionCookie);
      return fetch(`${baseUrl}/api/events?client=${encodeURIComponent(clientId)}`, { headers });
    },
    fetchRaw(path: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers);
      if (cookie) headers.set("cookie", cookie);
      return fetch(`${baseUrl}${path}`, { ...init, headers });
    },
    async request<T>(path: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers);
      if (cookie) headers.set("cookie", cookie);
      if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
      const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0];
      const body = (await response.json()) as T;
      return { response, body };
    },
  };
}

export const ownerAccount = {
  name: "Donavyn",
  email: "owner@example.com",
  password: "correct horse wizard tower",
};

export async function bootstrap(server: TestServer) {
  return server.request<{ user: { name: string; role: string } }>("/api/auth/bootstrap", {
    method: "POST",
    body: JSON.stringify(ownerAccount),
  });
}
