import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { demoAnalyticsScript } from "./demo-analytics";
import { applyLinkPreview, type LinkPreview } from "./link-preview";
import { OidcError } from "./oidc";

/*
 * The plumbing of every request and response: reading bodies and cookies, writing
 * JSON and files, the security headers, and the refusal type the error funnel
 * translates. Nothing here knows what a page or a project is.
 */

/** Ids name a file on disk, so anything that is not a plain uuid names nothing. */
export function previewEntityId(value: string | null): string | null {
  if (value === null) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

export async function readRaw(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > limit) throw new HttpError(413, "Request body is too large");
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function readJson(request: IncomingMessage): Promise<unknown> {
  const body = await readRaw(request, 1_000_000);
  if (body.length === 0) return {};
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
}

export function readCookie(request: IncomingMessage, name: string): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

export function requestClientId(request: IncomingMessage): string | null {
  const value = request.headers["x-grimoire-client-id"];
  if (typeof value === "string") return value.slice(0, 100);
  return value?.[0]?.slice(0, 100) ?? null;
}

export function json(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

/**
 * What the page is allowed to load, and from where.
 *
 * The build ships no inline script and Grimoire calls nothing off its own origin, so the
 * script and connection rules are as tight as they go and a bug that injects a `<script>` has
 * nowhere to load it from. Two entries are not tight, and both are deliberate:
 *
 * `style-src` allows inline styles because the interface sets custom properties through the
 * `style` attribute - a category's colour, a field's row count - and the editor's own styles
 * arrive as elements it inserts at runtime. Nonces cannot reach either.
 *
 * `img-src` allows any https source because a page's Markdown may link a picture that lives
 * somewhere else, and refusing those would break boards that already have them. It is a real
 * trade: an external image tells whoever hosts it that somebody here looked at that page.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'self' data: blob:",
  "manifest-src 'self'",
  "worker-src 'none'",
].join("; ");

export function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "same-origin");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

/**
 * Adds a cookie without displacing one already set.
 *
 * A single sign-in writes two: the session it just created, and the expiry of the short-lived
 * state cookie the provider flow used. `setHeader` would keep only the last of them.
 */
export function appendCookie(response: ServerResponse, value: string): void {
  const existing = response.getHeader("Set-Cookie");
  const cookies =
    existing === undefined ? [] : Array.isArray(existing) ? existing.map(String) : [String(existing)];
  response.setHeader("Set-Cookie", [...cookies, value]);
}

/**
 * Sends a failed provider sign-in back to the interface with something to say.
 *
 * The flow is a browser redirect rather than a fetch, so a JSON refusal would land the person
 * on a page of JSON. The message travels in the query string and the sign-in screen shows it
 * in the same banner a wrong password uses.
 */
export function redirectToSignIn(response: ServerResponse, returnTo: string, message: string): void {
  const target = new URL(returnTo, "http://placeholder.invalid");
  target.searchParams.set("signin_error", message);
  response.statusCode = 302;
  response.setHeader("Location", `${target.pathname}${target.search}`);
  response.setHeader("Cache-Control", "no-store");
  response.end();
}

/** A provider failure a person can read, without leaking what went wrong internally. */
export function oidcMessage(error: unknown): string {
  if (error instanceof OidcError) return error.message;
  console.error("oidc sign-in failed", error);
  return "The sign-in provider could not be reached.";
}

/** Unknown paths fall back to the shell so the client router can answer them. */
export function resolveStaticPath(pathname: string, directory: string): string | null {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed escape cannot name a build file, so the shell answers instead.
  }
  // Containment is asserted on the resolved result rather than proven by stripping
  // prefixes off the input. The old prefix-stripping happened to be safe only because
  // normalize() drops a leading '..' from absolute paths - an invariant nothing stated
  // and nothing checked. Whatever the request spelled, the answer is a file the build
  // directory contains, or the shell.
  const root = resolve(directory);
  const candidate = resolve(root, `.${normalize(`/${decoded}`)}`);
  const contained = candidate === root || candidate.startsWith(root + sep);
  const filePath = contained && candidate !== root ? candidate : join(root, "index.html");
  if (existsSync(filePath) && statSync(filePath).isFile()) return filePath;
  const shell = join(root, "index.html");
  return existsSync(shell) ? shell : null;
}

/** The shell is rewritten per request, so it is never stored by a cache or a proxy. */
export function serveDocument(
  response: ServerResponse,
  filePath: string,
  preview: LinkPreview | null,
  analyticsToken?: string,
): void {
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  let document = applyLinkPreview(readFileSync(filePath, "utf8"), preview);
  if (analyticsToken) {
    response.setHeader(
      "Content-Security-Policy",
      CONTENT_SECURITY_POLICY.replace(
        "script-src 'self'",
        "script-src 'self' https://static.cloudflareinsights.com",
      ).replace("connect-src 'self'", "connect-src 'self' https://cloudflareinsights.com"),
    );
    document = document.replace("</head>", `${demoAnalyticsScript(analyticsToken)}</head>`);
  }
  response.end(document);
}

/**
 * Streams a file with the failure handled, because a file can vanish between the
 * existence check and the read - and a stream error with no listener is an uncaught
 * exception that takes the whole process down, on a tick the route's error funnel
 * cannot see.
 */
export function sendFile(response: ServerResponse, filePath: string, contentType: string): void {
  const stream = createReadStream(filePath);
  stream.on("error", () => {
    if (response.headersSent) {
      response.destroy();
    } else {
      response.statusCode = 404;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ error: "File not found" }));
    }
  });
  response.statusCode = 200;
  response.setHeader("Content-Type", contentType);
  stream.pipe(response);
}

export function serveFile(response: ServerResponse, filePath: string): void {
  const contentTypes: Record<string, string> = {
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
  };
  sendFile(response, filePath, contentTypes[extname(filePath)] ?? "application/octet-stream");
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
