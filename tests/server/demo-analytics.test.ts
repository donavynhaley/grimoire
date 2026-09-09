import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { demoAnalyticsToken } from "../../server/demo-analytics";
import { startTestServer } from "./test-server";

const directories: string[] = [];
const token = "0123456789abcdef0123456789abcdef";

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function shell(): string {
  const directory = mkdtempSync(join(tmpdir(), "grimoire-demo-analytics-"));
  directories.push(directory);
  copyFileSync(resolve("index.html"), join(directory, "index.html"));
  return directory;
}

it("keeps demo analytics disabled unless the operator supplies a site token", async () => {
  const server = await startTestServer(undefined, { staticDirectory: shell() });
  const response = await server.fetchRaw("/demo");
  expect(await response.text()).not.toContain("cloudflareinsights");
  expect(response.headers.get("content-security-policy")).not.toContain("cloudflareinsights");
});

it("adds one non-SPA beacon only to demo documents and scopes its policy to those documents", async () => {
  const server = await startTestServer(undefined, {
    staticDirectory: shell(),
    demoAnalyticsToken: token,
  });
  for (const path of ["/demo", "/demo/", "/demo?project=fictional&page=example"]) {
    const response = await server.fetchRaw(path);
    const html = await response.text();
    expect(html.match(/beacon.min.js/g)).toHaveLength(1);
    expect(html).toContain(`data-cf-beacon='{"token":"${token}","spa":false}'`);
    expect(response.headers.get("content-security-policy")).toContain(
      "script-src 'self' https://static.cloudflareinsights.com",
    );
    expect(response.headers.get("content-security-policy")).toContain(
      "connect-src 'self' https://cloudflareinsights.com",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
  for (const path of ["/", "/?project=real", "/api/health", "/demo-other", "/demo/other"]) {
    const response = await server.fetchRaw(path);
    expect(await response.text()).not.toContain("cloudflareinsights");
    expect(response.headers.get("content-security-policy")).not.toContain("cloudflareinsights");
  }
});

it("rejects invalid site configuration before it can be injected into the document", () => {
  expect(demoAnalyticsToken(undefined)).toBeUndefined();
  expect(demoAnalyticsToken("  ")).toBeUndefined();
  expect(demoAnalyticsToken(` ${token} `)).toBe(token);
  for (const value of ["short", `${token}'><script>`, "g".repeat(32)]) {
    expect(() => demoAnalyticsToken(value)).toThrow("32-character hexadecimal site token");
  }
});
