import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrap, startTestServer } from "./test-server";

let gateway: ChildProcess | undefined;
afterEach(async () => {
  if (gateway && gateway.exitCode === null) {
    const exited = once(gateway, "exit");
    gateway.kill("SIGTERM");
    await exited;
  }
});

async function unusedPort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("No TCP address");
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return address.port;
}

describe("public demo gateway", () => {
  it("lets an anonymous visitor browse as a member while refusing every unlisted mutation and credential override", async () => {
    const app = await startTestServer();
    await bootstrap(app);
    const ownerCookie = app.cookie();
    const invite = await app.request<{ code: string }>("/api/invites", { method: "POST", body: "{}" });
    await app.request("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        name: "Morgan",
        email: "morgan@example.test",
        password: "a long enough password",
        inviteCode: invite.body.code,
      }),
    });
    const port = await unusedPort();
    const base = `http://127.0.0.1:${port}`;
    gateway = spawn(process.execPath, ["scripts/demo-gateway.mjs"], {
      env: { ...process.env, DEMO_UPSTREAM: app.baseUrl, HOST: "127.0.0.1", PORT: String(port) },
      stdio: "ignore",
    });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        ready = (await fetch(`${base}/api/health`)).ok;
      } catch {
        /* Starting. */
      }
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(ready).toBe(true);
    const session = await fetch(`${base}/api/session`, {
      headers: { cookie: ownerCookie, authorization: "Bearer ignored" },
    });
    expect(session.headers.get("set-cookie")).toBeNull();
    expect((await session.json()).user.email).toBe("morgan@example.test");
    expect((await fetch(`${base}/api/board`)).status).toBe(200);
    for (const path of [
      "/api/pages",
      "/api/auth/login",
      "/api/auth/bootstrap",
      "/api/invites",
      "/api/images",
      "/api/new-route",
      "/api/projects",
    ]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        expect((await fetch(base + path, { method, body: "{}" })).status, `${method} ${path}`).toBe(403);
      }
    }
    expect((await fetch(`${base}/api/agent-tokens`)).status).toBe(403);
    expect((await fetch(`${base}/api/new-route`)).status).toBe(403);
    expect(
      (
        await fetch(`${base}/api/seen`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(200);
  });
});
