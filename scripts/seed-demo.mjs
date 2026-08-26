/**
 * Fills a fresh Grimoire with something worth looking at.
 *
 * Everything here goes through the real HTTP API rather than into SQLite, so the demo is
 * built the same way a person and an agent would build it: accounts register, invitations
 * are redeemed, pages are created and moved, and the agent-written messages really do arrive
 * over a bearer token. If a route is broken this script fails instead of quietly producing a
 * database the running server disagrees with.
 *
 * Usage: node scripts/seed-demo.mjs [baseUrl]
 */

const BASE = (process.argv[2] ?? process.env.GRIMOIRE_URL ?? "http://127.0.0.1:8099").replace(/\/+$/, "");

/*
 * This script creates an owner account, invites somebody, and archives a project. That is
 * fine against the throwaway container it is written for and is not fine against anything
 * else, so it will only point at this machine unless somebody says otherwise in as many
 * words. A fresh instance answering on a public address is far more likely to be a mistake
 * than an invitation.
 */
const host = new URL(BASE).hostname;
const local = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
if (!local && process.env.GRIMOIRE_SEED_REMOTE !== "yes") {
  console.error(`Refusing to seed ${BASE}: it is not this machine.`);
  console.error("This bootstraps an owner and reshapes a project. Set GRIMOIRE_SEED_REMOTE=yes if you meant it.");
  process.exit(2);
}

const OWNER = { name: "Donavyn", email: "donavyn@team.example.test", password: "a long enough password" };
const TEAMMATE = { name: "Alan", email: "alan@team.example.test", password: "a long enough password" };

/** One signed-in browser: its own cookie, so two people can be seeded side by side. */
function person(label) {
  return { label, cookie: "", id: null };
}

const donavyn = person("Donavyn");
const alan = person("Alan");
let projectId = null;

async function call(who, path, { method = "GET", body, token, project = true } = {}) {
  const headers = { "content-type": "application/json" };
  /*
   * Never both. A browser session outranks a bearer header, so sending the cookie alongside
   * the token would make an "agent" write land as the person - attributed to nobody in
   * particular, and aimed at their default project rather than the token's own.
   */
  if (token) {
    headers.authorization = `Bearer ${token}`;
  } else {
    if (who?.cookie) headers.cookie = who.cookie;
    if (project && projectId) headers["x-grimoire-project"] = projectId;
  }

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  for (const value of setCookie) {
    if (value.startsWith("grimoire_session=")) who.cookie = value.split(";")[0];
  }
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status} ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return;
    } catch {
      // Not up yet. The container is usually a second or two behind the compose command.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Grimoire never became healthy at ${BASE}`);
}

// ---------------------------------------------------------------- the board

/**
 * Pages worth having a conversation about.
 *
 * `discussion` is the interesting part: each thread says who opened it, what came back, and
 * whether anyone considered it settled. Between them they cover every state the section can
 * be in - open, answered and folded away, written by an agent, and addressed to somebody by
 * name with an @.
 */
const PAGES = [
  {
    title: "NUTRITION: 'day log' - swap a logged meal without losing macros",
    status: "in_progress",
    category: "code",
    estimate: 8,
    assignee: "donavyn",
    description:
      "A subscriber who logged the wrong meal has to delete the entry and re-log, which loses " +
      "the timestamp and the day's running macro total.\n\n" +
      "- Swap in place from the day log row\n" +
      "- Keep the original logged time\n" +
      "- Recompute the day total, not the week\n",
    discussion: [
      {
        by: "alan",
        body: "The refund path in #612 touches this same reducer. Do you want me to land that first, or are you taking both?",
      },
      {
        by: "donavyn",
        body: "Does this need to handle a swap that changes the day's macro target, or only same-target swaps? The reducer branches hard on that.",
        replies: [{ by: "alan", body: "Same-target only for launch. Target changes are their own story - I'll split it out this week." }],
      },
      {
        by: "donavyn",
        body: "Whose clock are we writing? Device time is what the subscriber sees, but the ledger writes UTC.",
        replies: [{ by: "alan", body: "Device time for display, UTC for the ledger. Same rule as set logging." }],
        answeredBy: "donavyn",
      },
    ],
  },
  {
    title: "PAYMENTS: 'wallet' - refund path returns a stale credit balance",
    status: "review",
    category: "code",
    estimate: 3,
    assignee: "alan",
    description: "Refunding a week pass credits the wallet, but the balance read is served from cache for up to 60s.",
    discussion: [
      {
        by: "donavyn",
        body: "Is this the same cache the creator dashboard reads, or a second one? If it's shared, invalidating here fixes two bugs.",
      },
      {
        agent: true,
        body: "Deployed to dev at 09:14. Smoke tests green, regression suite green. Nothing needed from you - flagging it so the board is honest about where this is.",
      },
    ],
  },
  {
    title: "SECURITY: 'post service' - CORS allows any origin on the media upload route",
    status: "ready",
    category: "production",
    estimate: 5,
    assignee: "alan",
    description: "The upload route answers with `Access-Control-Allow-Origin: *`. Everything else on the service is scoped.",
    discussion: [
      {
        agent: true,
        body:
          "Swept the other 35 services for the same pattern while I was in here. Two more have it: notification-service " +
          "and the admin media proxy. Want them folded into this page, or their own?",
      },
    ],
  },
  {
    title: "TRAINING: 'set logging' - preserve set order and show set type colours",
    status: "done",
    category: "ui",
    estimate: 3,
    assignee: "alan",
    description: "Logged sets came back ordered by id rather than by the order they were performed.",
    discussion: [
      {
        by: "donavyn",
        body: "Did this need a migration for existing sessions, or does the ordering column already exist?",
        replies: [{ by: "alan", body: "Column existed, it just wasn't in the select. No migration." }],
        answeredBy: "donavyn",
      },
    ],
  },
  {
    title: "APP EXPERIENCE: 'home' - measure LCP against the poster image",
    status: "ready",
    category: "design",
    estimate: 5,
    assignee: null,
    description: "We keep guessing at what the home feed costs on a cold load. Measure before touching anything.",
    discussion: [
      {
        by: "alan",
        body: "@Donavyn nobody owns this yet - I'd like it before we cut the launch build. Can you take it, or should it wait?",
      },
    ],
  },
  {
    // The page that broke the first design. Nine threads is more than any real page should
    // carry, which is exactly why it is here: if the column reads at nine it reads at three.
    title: "PLATFORM: 'launch' - cut-over runbook for the production account",
    status: "in_progress",
    category: "production",
    estimate: 13,
    assignee: "donavyn",
    description:
      "Everything that has to happen in order on the day, and who is holding each step.\n\n" +
      "- DNS last, after the health checks pass\n" +
      "- Rollback is a DNS revert, not a redeploy\n",
    discussion: [
      { by: "alan", body: "Are we cutting over on the Friday or the Saturday? I can only cover Saturday." },
      { by: "donavyn", body: "Do we need the read replica up before the cut-over, or can it lag?", replies: [{ by: "alan", body: "It can lag. Nothing reads from it on day one." }] },
      { agent: true, body: "The five CDK blockers are down to two: the OpenSearch domain policy and the ACM cert in us-east-1. Both are mine unless you want them." },
      { by: "alan", body: "Who owns the status page during the window? I'd rather it wasn't whoever is doing the cut-over." },
      { by: "donavyn", body: "Should the old account stay warm for a week, or do we tear it down once DNS has settled?", answeredBy: "alan", replies: [{ by: "alan", body: "Warm for a week. It costs almost nothing and it is the only real rollback we have." }] },
      { by: "alan", body: "Rate limits on the new account are lower by default - do we need a quota increase before the window?" },
      { agent: true, body: "Ran the runbook against dev end to end. Step 7 assumes the migration has already run; it has not, at that point. Worth reordering." },
      { by: "donavyn", body: "Do we announce the maintenance window, or is the downtime short enough not to?", answeredBy: "donavyn", replies: [{ by: "alan", body: "Announce it. Two minutes unannounced is worse than ten announced." }] },
      { by: "alan", body: "@Donavyn last one: who has the domain registrar credentials? I don't, and DNS is the last step." },
    ],
  },
  {
    title: "IDENTITY: 'onboarding' - resend the verification email",
    status: "backlog",
    category: "code",
    estimate: 3,
    assignee: null,
    description: "There is no way to ask for the verification mail again short of registering a second account.",
    discussion: [],
  },
  {
    title: "PLATFORM: 'ci' - deploy failures should reach Discord, not email",
    status: "backlog",
    category: "production",
    estimate: 1,
    assignee: "donavyn",
    description: "Two workflows post failures to a webhook that has never been set.",
    discussion: [],
  },
];

// ---------------------------------------------------------------- seeding

async function main() {
  console.log(`Waiting for Grimoire at ${BASE} ...`);
  await waitForHealth();

  const session = await fetch(`${BASE}/api/session`).then((response) => response.json());
  if (session.status !== "setup_required") {
    console.log("This instance is already set up. Delete ./demo-data and start over to reseed.");
    process.exit(2);
  }

  console.log("Creating the owner account ...");
  const created = await call(donavyn, "/api/auth/bootstrap", { method: "POST", body: OWNER, project: false });
  donavyn.id = created.user.id;

  console.log("Creating the sample project ...");
  const project = await call(donavyn, "/api/projects", { method: "POST", body: { name: "sample" }, project: false });
  projectId = project.project.id;

  // Estimates on, so a tile carries an estimate pill beside the new open-threads pill and
  // the two can be seen not to fight.
  await call(donavyn, `/api/projects/${projectId}`, { method: "PATCH", body: { estimatesEnabled: true } });

  console.log("Inviting Alan ...");
  const invite = await call(donavyn, "/api/invites", { method: "POST", body: {} });
  const joined = await call(alan, "/api/auth/register", {
    method: "POST",
    body: { ...TEAMMATE, inviteCode: invite.code },
    project: false,
  });
  alan.id = joined.user.id;

  const who = { donavyn: donavyn.id, alan: alan.id };
  const speaker = { donavyn, alan };

  console.log("Issuing a credential for the Planning agent ...");
  const issued = await call(donavyn, "/api/agent-tokens", {
    method: "POST",
    body: { name: "Planning agent", scope: "write" },
  });
  const agentToken = issued.secret;

  console.log("Writing the board ...");
  let threadCount = 0;
  for (const spec of PAGES) {
    const { page } = await call(donavyn, "/api/pages", {
      method: "POST",
      body: {
        title: spec.title,
        description: spec.description,
        status: spec.status,
        category: spec.category,
        estimate: spec.estimate,
        assigneeId: spec.assignee ? who[spec.assignee] : null,
      },
    });

    for (const thread of spec.discussion) {
      // An agent posts over its bearer token, exactly as the MCP server does, so the message
      // really is attributed "Donavyn, via Planning agent" rather than faked to look that way.
      const opened = thread.agent
        ? await call(donavyn, `/api/pages/${page.id}/discussion`, {
          method: "POST",
          body: { body: thread.body },
          token: agentToken,
        })
        : await call(speaker[thread.by], `/api/pages/${page.id}/discussion`, {
          method: "POST",
          body: { body: thread.body },
        });
      threadCount += 1;

      for (const reply of thread.replies ?? []) {
        await call(speaker[reply.by], `/api/pages/${page.id}/discussion/${opened.thread.id}/replies`, {
          method: "POST",
          body: { body: reply.body },
        });
      }

      if (thread.answeredBy) {
        await call(speaker[thread.answeredBy], `/api/pages/${page.id}/discussion/${opened.thread.id}/answered`, {
          method: "POST",
          body: { answered: true },
        });
      }
    }
  }

  // The starter project bootstrap always makes would otherwise sit beside sample in the
  // picker with nothing in it.
  try {
    const projects = await call(donavyn, "/api/projects", { project: false });
    const starter = projects.projects.find((candidate) => candidate.name === "Wizard Simulator");
    if (starter) await call(donavyn, `/api/projects/${starter.id}`, { method: "DELETE", body: {}, project: false });
  } catch {
    // Not worth failing a demo over; it just means the picker shows two projects.
  }

  console.log("");
  console.log(`  ${PAGES.length} pages, ${threadCount} threads.`);
  console.log(`  Sign in at ${BASE}`);
  console.log(`    ${OWNER.email} / ${OWNER.password}    (owner)`);
  console.log(`    ${TEAMMATE.email} / ${TEAMMATE.password}    (teammate)`);
  console.log("");
}

await main();
