/**
 * End-to-end proof that a user can drive Grimoire through the MCP server.
 *
 * Starts a real Grimoire, bootstraps an owner, issues a real agent token through the real
 * HTTP route, then speaks the MCP protocol over stdio to the real built server binary and
 * checks the effects landed in Grimoire.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");

const directory = mkdtempSync(join(tmpdir(), "grimoire-e2e-"));
let grimoire;
let mcp;
const failures = [];
const passes = [];

function check(name, condition, detail = "") {
  if (condition) {
    passes.push(name);
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------- Grimoire

const { createGrimoireServer } = await import(`${ROOT}/server/app.ts`);

const app = createGrimoireServer({
  databasePath: join(directory, "grimoire.sqlite"),
  production: false,
});
await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
const port = app.server.address().port;
const baseUrl = `http://127.0.0.1:${port}`;
console.log(`\nGrimoire listening on ${baseUrl}`);

let cookie = "";
async function api(path, init = {}) {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("cookie", cookie);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  return { status: response.status, body: await response.json().catch(() => null) };
}

await api("/api/auth/bootstrap", {
  method: "POST",
  body: JSON.stringify({ name: "Donavyn", email: "owner@example.com", password: "correct horse wizard tower" }),
});

const issued = await api("/api/agent-tokens", {
  method: "POST",
  body: JSON.stringify({ name: "Planning agent", scope: "write" }),
});
const secret = issued.body.secret;
console.log(`Issued a real agent token: ${secret.slice(0, 12)}...\n`);

// ---------------------------------------------------------------- MCP client

mcp = spawn("node", [`${ROOT}/packages/grimoire-mcp/dist/index.js`], {
  env: { ...process.env, GRIMOIRE_URL: baseUrl, GRIMOIRE_TOKEN: secret },
  stdio: ["pipe", "pipe", "pipe"],
});
mcp.stderr.on("data", (chunk) => process.stderr.write(`  [mcp stderr] ${chunk}`));

let buffer = "";
const pending = new Map();
mcp.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    const resolver = pending.get(message.id);
    if (resolver) {
      pending.delete(message.id);
      resolver(message);
    }
  }
});

let nextId = 1;
function send(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    setTimeout(() => reject(new Error(`timed out: ${method}`)), 15000);
  });
}
function notify(method, params) {
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

async function callTool(name, args = {}) {
  const message = await send("tools/call", { name, arguments: args });
  const content = message.result?.content?.[0]?.text ?? JSON.stringify(message.error ?? message.result);
  return { text: content, isError: Boolean(message.result?.isError) };
}

try {
  // ------------------------------------------------------------ handshake
  console.log("Handshake");
  const init = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "e2e", version: "1.0.0" },
  });
  check("server identifies itself", init.result?.serverInfo?.name === "grimoire", JSON.stringify(init.result?.serverInfo));
  check("server ships usage instructions", String(init.result?.instructions ?? "").includes("page"));
  notify("notifications/initialized", {});

  // ------------------------------------------------------------ tool surface
  console.log("\nTool surface");
  const listed = await send("tools/list", {});
  const names = listed.result.tools.map((tool) => tool.name).sort();
  console.log(`  tools: ${names.join(", ")}`);
  const expected = [
    "grimoire_board",
    "grimoire_create_idea",
    "grimoire_create_page",
    "grimoire_list_ideas",
    "grimoire_move_page",
    "grimoire_search",
    "grimoire_update_page",
  ];
  check("exposes exactly the intended tools", JSON.stringify(names) === JSON.stringify(expected), names.join(","));
  check("no archive tool exists", !names.some((name) => name.includes("archive")));
  check("no promote tool exists", !names.some((name) => name.includes("promote")));
  check("no chapter-management tool exists", !names.some((name) => name.includes("chapter")));

  // ------------------------------------------------------------ read
  console.log("\nReading the board");
  const board = await callTool("grimoire_board");
  check("board names the project", board.text.includes("Wizard Simulator"));
  check("board says who the agent acts as", board.text.includes("Donavyn"));
  check("board lists the real categories", board.text.includes("Design") && board.text.includes("Code"));
  check("board shows every column", ["Backlog", "Up Next", "In progress", "Review", "Done"].every((c) => board.text.includes(c)));

  // ------------------------------------------------------------ create
  console.log("\nCreating pages by name, not by identifier");
  const created = await callTool("grimoire_create_page", {
    title: "Ward the tower door",
    notes: "## Acceptance\n- The door remembers who knocked.",
    column: "Up Next",
    category: "Code",
    assignee: "me",
  });
  check("create_page succeeds", !created.isError, created.text);
  check("create_page reports the column", created.text.includes("Up Next"), created.text);

  const inGrimoire = await api("/api/board");
  const page = inGrimoire.body.pages.find((candidate) => candidate.title === "Ward the tower door");
  check("the page really exists in Grimoire", Boolean(page));
  check("the human category name resolved to its slug", page?.category === "code", String(page?.category));
  check("\"me\" resolved to the issuing person", page?.assigneeName === "Donavyn", String(page?.assigneeName));
  check("the write is credited to the person", page?.createdByName === "Donavyn", String(page?.createdByName));

  // ------------------------------------------------------------ attribution
  console.log("\nAttribution in the activity log");
  const activity = await api("/api/activity");
  const event = activity.body.events.find((candidate) => candidate.entityTitle === "Ward the tower door");
  check("the log names the person", event?.actorName === "Donavyn", String(event?.actorName));
  check("the log names the agent beside them", event?.agentName === "Planning agent", String(event?.agentName));

  // ------------------------------------------------------------ resolution errors
  console.log("\nRefusing to guess");
  const badCategory = await callTool("grimoire_create_page", { title: "Nope", category: "Nonsense" });
  check("an unknown category is refused", badCategory.isError, badCategory.text);
  check("and the real options are listed", badCategory.text.includes("Design"), badCategory.text);

  const badColumn = await callTool("grimoire_move_page", { page: "Ward the tower door", column: "Somewhere" });
  check("an unknown column is refused", badColumn.isError, badColumn.text);

  // ------------------------------------------------------------ search + update + move
  console.log("\nSearch, edit, move");
  const found = await callTool("grimoire_search", { query: "tower" });
  check("search finds the page", found.text.includes("Ward the tower door"), found.text);
  check("search returns an id to act on", found.text.includes(page.id), found.text);

  const updated = await callTool("grimoire_update_page", {
    page: "Ward the tower door",
    notes: "## Acceptance\n- The door remembers who knocked.\n- It forgets after a week.",
  });
  check("update_page succeeds", !updated.isError, updated.text);

  const moved = await callTool("grimoire_move_page", { page: "Ward the tower door", column: "In progress" });
  check("move_page succeeds", !moved.isError, moved.text);
  check("move_page names both columns", moved.text.includes("Up Next") && moved.text.includes("In progress"), moved.text);

  const afterMove = await api("/api/board");
  const movedPage = afterMove.body.pages.find((candidate) => candidate.id === page.id);
  check("the page really moved", movedPage?.status === "in_progress", String(movedPage?.status));
  check("the notes really changed", movedPage?.description.includes("forgets after a week"), String(movedPage?.description));

  // ------------------------------------------------------------ conflict
  console.log("\nA concurrent edit is surfaced, not overwritten");
  // What the agent read before it started composing its edit.
  const readEarlier = (await api("/api/board")).body.pages.find((c) => c.id === page.id).description;
  // A person rewrites the notes directly, after the agent read them.
  await api(`/api/pages/${page.id}`, {
    method: "PATCH",
    body: JSON.stringify({ description: "Rewritten by a person at a browser." }),
  });
  // The agent writes from its stale reading, declaring what it thought was there.
  const conflicting = await callTool("grimoire_update_page", {
    page: page.id,
    notes: "The agent's version, which must not silently win.",
    expectedNotes: readEarlier,
  });
  check("the stale write is refused, not applied", conflicting.isError, conflicting.text);
  check("the refusal explains what to do next", conflicting.text.includes("re-read"), conflicting.text);
  check("the refusal carries the stored version", conflicting.text.includes("Rewritten by a person"), conflicting.text);

  const afterConflict = await api("/api/board");
  const conflictPage = afterConflict.body.pages.find((candidate) => candidate.id === page.id);
  check(
    "the person's words are still there",
    conflictPage.description.includes("Rewritten by a person"),
    conflictPage.description,
  );

  // And the agent can then land its edit by declaring the version it now knows about.
  const resolved = await callTool("grimoire_update_page", {
    page: page.id,
    notes: "Merged by the agent, after reading what the person wrote.",
    expectedNotes: conflictPage.description,
  });
  check("re-reading and retrying succeeds", !resolved.isError, resolved.text);

  // ------------------------------------------------------------ ideas
  console.log("\nIdeas");
  const idea = await callTool("grimoire_create_idea", { title: "Familiars could learn habits" });
  check("create_idea succeeds", !idea.isError, idea.text);
  const ideaList = await callTool("grimoire_list_ideas");
  check("the idea is listed", ideaList.text.includes("Familiars could learn habits"), ideaList.text);

  // ------------------------------------------------------------ the never-list, through the tools
  console.log("\nWhat the agent cannot do, proven against the server");
  const archiveAttempt = await fetch(`${baseUrl}/api/pages/${page.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${secret}` },
  });
  check("the token cannot archive", archiveAttempt.status === 403, String(archiveAttempt.status));

  const chapterAttempt = await fetch(`${baseUrl}/api/chapters`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "First Brew" }),
  });
  check("the token cannot create a chapter", chapterAttempt.status === 403, String(chapterAttempt.status));

  // ------------------------------------------------------------ revocation
  console.log("\nRevocation stops it immediately");
  const tokens = await api("/api/agent-tokens");
  await api(`/api/agent-tokens/${tokens.body.tokens[0].id}`, { method: "DELETE" });
  const afterRevoke = await callTool("grimoire_create_page", { title: "Should never be created" });
  check("the agent is refused after revocation", afterRevoke.isError, afterRevoke.text);
  check("and is told why in words it can act on", afterRevoke.text.includes("revoked") || afterRevoke.text.includes("refused"), afterRevoke.text);

  const finalBoard = await api("/api/board");
  check(
    "nothing was written after revocation",
    !finalBoard.body.pages.some((candidate) => candidate.title === "Should never be created"),
  );
} catch (error) {
  failures.push(`threw: ${error.message}`);
  console.log(`\n  ERROR ${error.stack}`);
} finally {
  mcp?.kill();
  app.closeEventStreams();
  await new Promise((resolve) => app.server.close(resolve));
  app.close();
  rmSync(directory, { recursive: true, force: true });
}

console.log(`\n${"=".repeat(60)}`);
console.log(`${passes.length} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log("Failures:");
  for (const failure of failures) console.log(`  - ${failure}`);
}
process.exit(failures.length === 0 ? 0 : 1);
