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

/**
 * GitHub, stubbed. The poller's only seam on the outside world is a fetcher, so the link can
 * be exercised end to end without a real pull request existing anywhere.
 */
const pullRequests = {
  "wizards/simulator#12": {
    number: 12,
    title: "Hold the circle",
    html_url: "https://github.com/wizards/simulator/pull/12",
    state: "open",
    draft: false,
    merged_at: null,
  },
};
const githubFetcher = async (path) => {
  const pull = path.match(/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/);
  if (!pull) return { status: 404, body: null };
  const answer = pullRequests[`${pull[1]}#${pull[2]}`];
  return answer ? { status: 200, body: answer } : { status: 404, body: null };
};

const app = createGrimoireServer({
  databasePath: join(directory, "grimoire.sqlite"),
  production: false,
  githubFetcher,
  // A fresh link resolves before the PATCH answers, so the checks never need the timer -
  // and a timer running underneath them would only race what they assert.
  githubPollMs: 0,
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
  body: JSON.stringify({
    name: "Donavyn",
    email: "owner@example.com",
    password: "correct horse wizard tower",
  }),
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
  for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
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

/** Spawns a fresh server process for one credential and returns its sorted tool names. */
async function listToolsAs(tokenSecret) {
  const child = spawn("node", [`${ROOT}/packages/grimoire-mcp/dist/index.js`], {
    env: { ...process.env, GRIMOIRE_URL: baseUrl, GRIMOIRE_TOKEN: tokenSecret },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    let chunkBuffer = "";
    const waiting = new Map();
    child.stdout.on("data", (chunk) => {
      chunkBuffer += chunk.toString();
      for (let index = chunkBuffer.indexOf("\n"); index >= 0; index = chunkBuffer.indexOf("\n")) {
        const line = chunkBuffer.slice(0, index).trim();
        chunkBuffer = chunkBuffer.slice(index + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        waiting.get(message.id)?.(message);
      }
    });
    let id = 0;
    const ask = (method, params) =>
      new Promise((resolve, reject) => {
        waiting.set(++id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        setTimeout(() => reject(new Error(`timed out: ${method}`)), 15000);
      });
    await ask("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "e2e", version: "1.0.0" },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
    );
    const listed = await ask("tools/list", {});
    return listed.result.tools.map((tool) => tool.name).sort();
  } finally {
    child.kill();
  }
}

try {
  // ------------------------------------------------------------ handshake
  console.log("Handshake");
  const init = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "e2e", version: "1.0.0" },
  });
  check(
    "server identifies itself",
    init.result?.serverInfo?.name === "grimoire",
    JSON.stringify(init.result?.serverInfo),
  );
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
    "grimoire_post_in_discussion",
    "grimoire_read_discussion",
    "grimoire_read_page",
    "grimoire_reply_in_discussion",
    "grimoire_search",
    "grimoire_update_page",
  ];
  check(
    "exposes exactly the intended tools",
    JSON.stringify(names) === JSON.stringify(expected),
    names.join(","),
  );
  check("no archive tool exists", !names.some((name) => name.includes("archive")));
  check("no promote tool exists", !names.some((name) => name.includes("promote")));
  check("no chapter-management tool exists", !names.some((name) => name.includes("chapter")));

  // ------------------------------------------------------------ read
  console.log("\nReading the board");
  const board = await callTool("grimoire_board");
  check("board names the project", board.text.includes("Wizard Simulator"));
  check("board says who the agent acts as", board.text.includes("Donavyn"));
  check("board lists the real categories", board.text.includes("Design") && board.text.includes("Code"));
  check(
    "board shows every column",
    ["Backlog", "Up Next", "In progress", "Review", "Done"].every((c) => board.text.includes(c)),
  );

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
  check('"me" resolved to the issuing person', page?.assigneeName === "Donavyn", String(page?.assigneeName));
  check(
    "the write is credited to the person",
    page?.createdByName === "Donavyn",
    String(page?.createdByName),
  );

  // ------------------------------------------------------------ attribution
  console.log("\nAttribution in the activity log");
  const activity = await api("/api/activity");
  const event = activity.body.events.find((candidate) => candidate.entityTitle === "Ward the tower door");
  check("the log names the person", event?.actorName === "Donavyn", String(event?.actorName));
  check(
    "the log names the agent beside them",
    event?.agentName === "Planning agent",
    String(event?.agentName),
  );

  // ------------------------------------------------------- discussion
  console.log("\nDiscussion");
  // A person asks something on the page the agent is working.
  const pageId = page.id;
  const asked = await api(`/api/pages/${pageId}/discussion`, {
    method: "POST",
    body: JSON.stringify({ body: "Does this need the migration first?" }),
  });
  check("a person can open a thread", asked.status === 201, String(asked.status));

  const seen = await callTool("grimoire_read_discussion", { page: "Ward the tower door" });
  check("the agent reads the discussion", !seen.isError, seen.text);
  check("an unanswered thread reads as open", seen.text.includes("[OPEN]"), seen.text);
  check("and carries the question", seen.text.includes("Does this need the migration first?"), seen.text);
  const threadId = seen.text.match(/id: ([0-9a-f-]{36})/)?.[1];
  check("the agent is given an id to reply with", Boolean(threadId), seen.text);

  const answered = await callTool("grimoire_reply_in_discussion", {
    page: "Ward the tower door",
    thread: threadId,
    body: "It does. I ran it first and it moved 412 rows.",
  });
  check("the agent replies in the thread it was asked in", !answered.isError, answered.text);
  check("and is told it cannot close the thread", answered.text.includes("person"), answered.text);

  const reported = await callTool("grimoire_post_in_discussion", {
    page: "Ward the tower door",
    body: "Deployed to dev. Smoke tests green, nothing needed from you.",
  });
  check("the agent can report by opening its own thread", !reported.isError, reported.text);

  const threads = await api(`/api/pages/${pageId}/discussion`);
  check(
    "Grimoire holds both threads",
    threads.body.threads.length === 2,
    String(threads.body.threads.length),
  );
  const asking = threads.body.threads.find((thread) => thread.body.includes("migration"));
  check(
    "the reply landed on the right thread",
    asking?.replies.length === 1,
    JSON.stringify(asking?.replies),
  );
  // A token is a delegation: the person stays the author and the agent is named beside them.
  check(
    "the reply is credited to the person",
    asking?.replies[0]?.authorName === "Donavyn",
    String(asking?.replies[0]?.authorName),
  );
  check(
    "and names the agent beside them",
    asking?.replies[0]?.agentName === "Planning agent",
    String(asking?.replies[0]?.agentName),
  );
  check(
    "both threads are still open",
    threads.body.threads.every((thread) => thread.answeredAt === null),
  );

  // The judgement that a question is settled is a person's, and no tool offers it.
  check(
    "no tool can close a thread",
    !names.some((name) => name.includes("answer") && name !== "grimoire_reply_in_discussion"),
  );
  const closeAttempt = await fetch(`${baseUrl}/api/pages/${pageId}/discussion/${threadId}/answered`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ answered: true }),
  });
  check(
    "and the route itself refuses the credential",
    closeAttempt.status === 403,
    String(closeAttempt.status),
  );

  // The notes are the brief; reporting never rewrites them.
  const afterTalking = await api(`/api/pages/${pageId}`);
  check(
    "the page's notes are untouched by all of it",
    afterTalking.body.page.description === page.description,
  );
  check(
    "and the page reports its open threads",
    afterTalking.body.page.openThreads === 2,
    String(afterTalking.body.page.openThreads),
  );

  // ------------------------------------------------------------ resolution errors
  console.log("\nRefusing to guess");
  const badCategory = await callTool("grimoire_create_page", { title: "Nope", category: "Nonsense" });
  check("an unknown category is refused", badCategory.isError, badCategory.text);
  check("and the real options are listed", badCategory.text.includes("Design"), badCategory.text);

  const badColumn = await callTool("grimoire_move_page", {
    page: "Ward the tower door",
    column: "Somewhere",
  });
  check("an unknown column is refused", badColumn.isError, badColumn.text);

  // ------------------------------------------------------------ search + update + move
  console.log("\nSearch, edit, move");
  const found = await callTool("grimoire_search", { query: "tower" });
  check("search finds the page", found.text.includes("Ward the tower door"), found.text);
  check("search returns an id to act on", found.text.includes(page.id), found.text);

  // A rewrite with no declared expectation must be refused, not silently last-writer-wins.
  const blind = await callTool("grimoire_update_page", {
    page: "Ward the tower door",
    notes: "A blind rewrite that must not land.",
  });
  check("a notes rewrite without expectedNotes is refused", blind.isError, blind.text);
  check("the refusal points at grimoire_read_page", blind.text.includes("grimoire_read_page"), blind.text);

  const readBack = await callTool("grimoire_read_page", { page: "Ward the tower door" });
  check(
    "read_page returns the stored notes verbatim",
    readBack.text.includes("The door remembers who knocked."),
    readBack.text,
  );

  const updated = await callTool("grimoire_update_page", {
    page: "Ward the tower door",
    notes: "## Acceptance\n- The door remembers who knocked.\n- It forgets after a week.",
    expectedNotes: "## Acceptance\n- The door remembers who knocked.",
  });
  check("update_page succeeds with a true expectation", !updated.isError, updated.text);

  // A half-remembered title must never silently pick a page for a destructive rewrite.
  const partial = await callTool("grimoire_update_page", {
    page: "tower",
    notes: "x",
    expectedNotes: "x",
  });
  check("a partial title is refused, not guessed", partial.isError, partial.text);
  check("the refusal lists the close match with its id", partial.text.includes(page.id), partial.text);

  const moved = await callTool("grimoire_move_page", { page: "Ward the tower door", column: "In progress" });
  check("move_page succeeds", !moved.isError, moved.text);
  check(
    "move_page names both columns",
    moved.text.includes("Up Next") && moved.text.includes("In progress"),
    moved.text,
  );

  const afterMove = await api("/api/board");
  const movedPage = afterMove.body.pages.find((candidate) => candidate.id === page.id);
  check("the page really moved", movedPage?.status === "in_progress", String(movedPage?.status));
  check(
    "the notes really changed",
    movedPage?.description.includes("forgets after a week"),
    String(movedPage?.description),
  );

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
  check(
    "the refusal carries the stored version",
    conflicting.text.includes("Rewritten by a person"),
    conflicting.text,
  );

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

  // ------------------------------------------------------------ the project's own fields
  console.log("\nA project's own fields");
  await api("/api/fields", {
    method: "POST",
    body: JSON.stringify({
      label: "Priority",
      type: "select",
      options: ["p0", "p1", "p2"],
      showOnTile: true,
    }),
  });
  await api("/api/fields", { method: "POST", body: JSON.stringify({ label: "Estimate", type: "number" }) });

  const withFields = await callTool("grimoire_board");
  check(
    "the board names the fields and their options",
    withFields.text.includes("Priority (p0 | p1 | p2)"),
    withFields.text,
  );

  const fieldPage = await callTool("grimoire_create_page", {
    title: "Reconcile the stale backlog",
    column: "Up Next",
    // Said the way a person would say it, in the wrong case and by label rather than key.
    fields: { Priority: "P0", estimate: 3 },
  });
  check("a page can be created carrying field values", !fieldPage.isError, fieldPage.text);

  const fieldsReadBack = await callTool("grimoire_read_page", { page: "Reconcile the stale backlog" });
  check("the values read back by label", fieldsReadBack.text.includes("Priority: p0"), fieldsReadBack.text);
  check(
    "and the number survived being written",
    fieldsReadBack.text.includes("Estimate: 3"),
    fieldsReadBack.text,
  );

  const patched = await callTool("grimoire_update_page", {
    page: "Reconcile the stale backlog",
    fields: { priority: "p2" },
  });
  check("setting one field leaves the others alone", patched.text.includes("Estimate: 3"), patched.text);
  check("and the one that was set has moved", patched.text.includes("Priority: p2"), patched.text);

  const badOption = await callTool("grimoire_update_page", {
    page: "Reconcile the stale backlog",
    fields: { priority: "urgent" },
  });
  check("an option that is not offered is refused", badOption.isError, badOption.text);
  check("and the refusal lists the real options", badOption.text.includes("p0, p1, p2"), badOption.text);

  const unknownField = await callTool("grimoire_update_page", {
    page: "Reconcile the stale backlog",
    fields: { velocity: 9 },
  });
  check("a field nobody defined is refused", unknownField.isError, unknownField.text);

  const defineAttempt = await fetch(`${baseUrl}/api/fields`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ label: "Velocity", type: "number" }),
  });
  check("the token cannot define a field", defineAttempt.status === 403, String(defineAttempt.status));

  // ------------------------------------------------------------ ideas
  console.log("\nIdeas");
  const idea = await callTool("grimoire_create_idea", { title: "Familiars could learn habits" });
  check("create_idea succeeds", !idea.isError, idea.text);
  const ideaList = await callTool("grimoire_list_ideas");
  check("the idea is listed", ideaList.text.includes("Familiars could learn habits"), ideaList.text);

  // ------------------------------------------------------------ tying a page to a pull request
  console.log("\nTying a page to the work that delivers it");
  await api(`/api/projects/${inGrimoire.body.project.id}`, {
    method: "PATCH",
    body: JSON.stringify({ githubRepo: "wizards/simulator", githubToken: "ghp_secret" }),
  });

  const toLink = await callTool("grimoire_create_page", { title: "Hold the circle", column: "In progress" });
  const toLinkId = toLink.text.match(/id: (\S+)/)?.[1];
  const linked = await callTool("grimoire_update_page", { page: toLinkId, github: "#12" });
  check("a pull request can be linked through the tool", !linked.isError, linked.text);
  check("and the reply names the pull request", linked.text.includes("PR #12"), linked.text);

  // The point of the real field over a line in the notes: the board follows the code.
  const afterLink = await api("/api/board");
  const linkedPage = afterLink.body.pages.find((candidate) => candidate.id === toLinkId);
  check(
    "Grimoire stored a real link, not text",
    linkedPage?.github?.number === 12,
    JSON.stringify(linkedPage?.github),
  );
  check(
    "an open pull request moved the page to Review",
    linkedPage?.status === "review",
    String(linkedPage?.status),
  );

  // An agent that cannot see an existing link would either link it twice or paste a URL
  // into the notes, so reading it back is as much the feature as writing it.
  const readLinked = await callTool("grimoire_read_page", { page: toLinkId });
  check("read_page shows the link and its state", /PR #12.*open/.test(readLinked.text), readLinked.text);
  const boardLinked = await callTool("grimoire_board");
  check("the board shows it too", boardLinked.text.includes("PR #12"), boardLinked.text);

  const badLink = await callTool("grimoire_update_page", { page: toLinkId, github: "not a pull request!!" });
  check("something unreadable as a reference is refused", badLink.isError, badLink.text);

  const unlinked = await callTool("grimoire_update_page", { page: toLinkId, github: null });
  check("passing null unlinks", !unlinked.isError, unlinked.text);
  const afterUnlink = await api("/api/board");
  check(
    "and the link is really gone",
    !afterUnlink.body.pages.find((candidate) => candidate.id === toLinkId)?.github,
    JSON.stringify(afterUnlink.body.pages.find((candidate) => candidate.id === toLinkId)?.github),
  );

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
  check(
    "and is told why in words it can act on",
    afterRevoke.text.includes("revoked") || afterRevoke.text.includes("refused"),
    afterRevoke.text,
  );

  const finalBoard = await api("/api/board");
  check(
    "nothing was written after revocation",
    !finalBoard.body.pages.some((candidate) => candidate.title === "Should never be created"),
  );

  // ------------------------------------------------------------ read scope shapes the surface
  console.log("\nA read-only credential is offered only the reading tools");
  const readIssued = await api("/api/agent-tokens", {
    method: "POST",
    body: JSON.stringify({ name: "Reader", scope: "read" }),
  });
  const readTools = await listToolsAs(readIssued.body.secret);
  check(
    "read scope registers exactly the reading tools",
    JSON.stringify(readTools) ===
      JSON.stringify([
        "grimoire_board",
        "grimoire_list_ideas",
        // Reading what was asked is a read; only saying something back is a write.
        "grimoire_read_discussion",
        "grimoire_read_page",
        "grimoire_search",
      ]),
    readTools.join(","),
  );

  // ------------------------------------------------------------ archiving a project stops its agents
  console.log("\nArchiving a project suspends its credentials");
  const second = await api("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Second project" }),
  });
  const secondToken = await api(`/api/agent-tokens?project=${second.body.project.id}`, {
    method: "POST",
    body: JSON.stringify({ name: "Doomed agent", scope: "write" }),
  });
  const beforeArchive = await fetch(`${baseUrl}/api/board`, {
    headers: { authorization: `Bearer ${secondToken.body.secret}` },
  });
  check(
    "the second project's token works before archiving",
    beforeArchive.status === 200,
    String(beforeArchive.status),
  );

  await api(`/api/projects/${second.body.project.id}`, { method: "DELETE", body: "{}" });
  const afterArchive = await fetch(`${baseUrl}/api/board`, {
    headers: { authorization: `Bearer ${secondToken.body.secret}` },
  });
  check(
    "and is refused once the project is archived",
    afterArchive.status === 401,
    String(afterArchive.status),
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
