/** An anonymous entrance to the disposable demo, using a seeded member account. */
import { createServer, request as proxyRequest } from "node:http";

const upstream = new URL(process.env.DEMO_UPSTREAM ?? "http://grimoire-demo:8080");
if (upstream.protocol !== "http:") throw new Error("The demo upstream must be on the private HTTP network");
const login = await fetch(new URL("/api/auth/login", upstream), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "morgan@example.test", password: "a long enough password" }),
});
if (!login.ok) throw new Error("Seed the isolated demo before starting its gateway");
const cookie = login.headers
  .getSetCookie()
  .find((value) => value.startsWith("grimoire_session="))
  ?.split(";")[0];
if (!cookie) throw new Error("The demo did not issue a session");

// Only browsing and attention markers are public. New API routes are closed by default.
function allowed(method, path) {
  if (method === "GET") {
    return (
      [
        "/api/health",
        "/api/session",
        "/api/board",
        "/api/projects",
        "/api/search",
        "/api/ideas",
        "/api/away",
        "/api/events",
        "/api/activity",
        "/api/agent-review",
      ].includes(path) ||
      /^\/api\/pages\/[^/]+(?:\/discussion)?$/.test(path) ||
      /^\/api\/(?:images|avatars)\/[^/]+$/.test(path)
    );
  }
  return (
    method === "POST" &&
    (["/api/seen", "/api/agent-review/seen"].includes(path) ||
      /^\/api\/pages\/[^/]+\/discussion\/seen$/.test(path))
  );
}

const banner =
  '<aside class="public-demo-banner">Public demo · Browse the sample board. Changes are disabled. <a href="https://github.com/donavynhaley/grimoire">Run your own Grimoire</a></aside>';
const css =
  ".public-demo-banner{padding:.75rem 1rem;background:#233021;color:#d8d9d1;font:14px/1.5 monospace;text-align:center}.public-demo-banner a{color:#b8d99b;text-decoration:underline}.public-demo-banner a:focus-visible{outline:2px solid #b8d99b;outline-offset:3px}";

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://demo.invalid");
  const path = url.pathname;
  if (path === "/demo-banner.css" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/css", "cache-control": "no-store" });
    res.end(css);
    return;
  }
  if (path.startsWith("/api/") ? !allowed(req.method ?? "GET", path) : req.method !== "GET") {
    res.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: "This demo is read-only. Run your own Grimoire to make changes." }));
    req.resume();
    return;
  }
  // Construct from a fixed origin, never from a client-controlled absolute request target.
  const target = new URL(upstream);
  target.pathname = path;
  target.search = url.search;
  const headers = { cookie, accept: req.headers.accept ?? "*/*" };
  for (const name of ["content-type", "content-length", "x-grimoire-project", "x-grimoire-client"]) {
    if (req.headers[name]) headers[name] = req.headers[name];
  }
  const proxied = proxyRequest(target, { method: req.method, headers }, (response) => {
    const outgoing = { ...response.headers, "cache-control": "no-store" };
    delete outgoing["set-cookie"];
    delete outgoing["content-length"];
    res.writeHead(response.statusCode ?? 502, outgoing);
    response.on("error", () => res.destroy());
    if (String(response.headers["content-type"]).includes("text/html")) {
      let html = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        html += chunk;
      });
      response.on("end", () =>
        res.end(
          html
            .replace("</head>", '<link rel="stylesheet" href="/demo-banner.css"></head>')
            .replace("<body>", `<body>${banner}`),
        ),
      );
    } else {
      response.pipe(res);
    }
  });
  proxied.on("error", () => {
    if (res.headersSent) res.destroy();
    else {
      res.writeHead(502);
      res.end("The demo is restarting. Please try again shortly.");
    }
  });
  req.on("aborted", () => proxied.destroy());
  res.on("close", () => proxied.destroy());
  req.pipe(proxied);
});
server.listen(Number(process.env.PORT ?? 8080), process.env.HOST ?? "0.0.0.0");
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
