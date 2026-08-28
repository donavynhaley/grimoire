import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { startTestServer } from "./test-server";

/** The shipped shell, served the way production serves it. */
function shellDirectory(): string {
  const directory = join(mkdtempSync(join(tmpdir(), "grimoire-shell-")), "dist");
  mkdirSync(directory, { recursive: true });
  copyFileSync(resolve("index.html"), join(directory, "index.html"));
  return directory;
}

/** The directives a page has to be held to, whatever else the policy grows to say. */
function directive(policy: string, name: string): string | null {
  const found = policy
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `));
  return found ? found.slice(name.length + 1) : null;
}

describe("security headers", () => {
  it("sends a content security policy that leaves script with nowhere to come from", async () => {
    const server = await startTestServer();

    const health = await server.fetchRaw("/api/health");
    const policy = health.headers.get("content-security-policy");
    expect(policy).toBeTruthy();

    expect(directive(policy!, "default-src")).toBe("'self'");
    expect(directive(policy!, "script-src")).toBe("'self'");
    expect(directive(policy!, "connect-src")).toBe("'self'");
    expect(directive(policy!, "object-src")).toBe("'none'");
    expect(directive(policy!, "base-uri")).toBe("'none'");
    expect(directive(policy!, "frame-ancestors")).toBe("'none'");
    expect(directive(policy!, "form-action")).toBe("'self'");

    // No escape hatch for script: an injected tag has nowhere to load from and nothing
    // inline to run, which is the whole point of the header.
    expect(directive(policy!, "script-src")).not.toContain("unsafe-inline");
    expect(directive(policy!, "script-src")).not.toContain("unsafe-eval");
  });

  it("allows the inline styles and remote pictures the interface actually uses", async () => {
    const server = await startTestServer();
    const policy = (await server.fetchRaw("/api/health")).headers.get("content-security-policy")!;

    // Category colours and row counts are set through the style attribute, and the editor
    // inserts its own styles at runtime; neither can carry a nonce.
    expect(directive(policy, "style-src")).toContain("'unsafe-inline'");
    // A page's Markdown may link a picture that lives somewhere else.
    expect(directive(policy, "img-src")).toContain("https:");
    expect(directive(policy, "img-src")).toContain("data:");
  });

  it("puts the policy on the page itself, not only on the API", async () => {
    const server = await startTestServer(undefined, { staticDirectory: shellDirectory() });

    const document = await server.fetchRaw("/");
    expect(document.headers.get("content-type")).toContain("text/html");
    expect(document.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(document.headers.get("x-frame-options")).toBe("DENY");
    expect(document.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("never serves a file the build directory does not contain", async () => {
    const directory = shellDirectory();
    // A real prize one directory up from the build, where a traversal would land.
    writeFileSync(join(directory, "..", "secret.txt"), "the operator's secret");
    const server = await startTestServer(undefined, { staticDirectory: directory });

    // Spelled plainly and spelled through percent-encoding, which decodes after
    // routing and so reaches the resolver as a real dot-dot.
    for (const path of [
      "/../secret.txt",
      "/%2e%2e/secret.txt",
      "/..%2fsecret.txt",
      "/assets/%2e%2e/%2e%2e/secret.txt",
    ]) {
      const answer = await server.fetchRaw(path);
      const body = await answer.text();
      expect(body, path).not.toContain("the operator's secret");
      expect(answer.headers.get("content-type"), path).toContain("text/html");
    }
  });
});
