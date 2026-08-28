# Grimoire coding standards

This document is canon, adopted August 2026. It is the ruler the codebase is
measured against: every standard has an ID so an audit or a review can cite it
(`SRV-3`), and `docs/code-audit-2026-08.md` is the current measurement.

New code is held to every standard here. Existing code that falls short is not a
reason to relax a standard — it is an audit finding with a place in the plan.
Amend by editing; when a standard dies, delete it rather than crossing it out, and
let Git remember.

---

## 1. Architecture and boundaries

**ARCH-1.** The Markdown files are the canonical record for work pages,
ideas, and chapters. SQLite holds only operational collaboration data — accounts,
sessions, membership, the activity log, discussion. Nothing may cache domain data in
SQLite or write operational data into the Markdown. `docs/architecture.md` § Storage
boundary is the authority.

**ARCH-2.** Every design decision that costs something gets written down
with its reason in `docs/architecture.md`, in prose, at the moment it is made. The
doc explains *why*, not just *what* — a reader should be able to reconstruct the
alternative that was rejected.

**ARCH-3.** Backward compatibility is a feature. New frontmatter keys are
additive and emitted only when they carry a value, so untouched projects keep
byte-identical files and a rollback has a defined story. API routes that a deployed
bundle may still be calling keep answering (`/api/cards` aliases `/api/pages`).

**ARCH-4.** File writes are atomic: temp file, flush, rename. Multi-file
operations are deterministic with documented tie-breakers, never half-configured.

**ARCH-5.** The server is the authority. The client never trusts its own
optimistic state for correctness — reversible actions (archive, promotion undo) are
server-backed, and concurrent edits use per-field compare-and-swap, not last-writer-wins.

**ARCH-6.** One module, one job, stated in one sentence. A file whose
job needs "and" in it is two files. This is the standard the current `server/app.ts`
and `Board.tsx` will be measured against.

## 2. TypeScript

**TS-1.** `strict: true` everywhere, `noEmit` type-checking gates the
build (`npm run check` runs inside `npm run build`).

**TS-2.** No `as any`, no `@ts-ignore`. `@ts-expect-error` is allowed
only with a comment naming the upstream reason. A cast (`as X`) is allowed only at a
validated boundary — immediately after a zod parse or an explicit runtime check.

**TS-3.** Enable `noUncheckedIndexedAccess` and `noImplicitOverride` in
the root tsconfig. Indexed lookups into records of user data return `T | undefined`
in reality; the types should say so.

**TS-4.** Shared request/response shapes live in `shared/types.ts` and are
imported by both sides. A shape defined twice is a drift waiting to be a bug.

**TS-5.** Exported functions declare their return type. Inference is fine
inside a module; a public surface states its contract. React components are the
one exemption — an explicit `JSX.Element` restates what the file extension already
says.

**TS-6.** A response leaves the server through a typed door. The `json()`
helper takes the shared response type for its route, not `unknown` — so a hand-built
payload that drifts from `shared/types.ts` fails the build instead of the client.

**TS-7.** Enum-shaped unions are defined once, as the `as const` tuple in
`shared/types.ts`, and every `z.enum`, label table, and column list derives from that
tuple. A literal string array that restates one is a drift bug, not a style choice.

## 3. Naming and layout

**NAME-1.** Components are `PascalCase.tsx`. Hooks are `use-*.ts`
(kebab-case file, camelCase export). Non-component helpers are `kebab-case.ts`.
Server modules are `kebab-case.ts` named for their domain (`agent-tokens.ts`,
`login-rate-limit.ts`), not for their pattern (`utils.ts`, `helpers.ts` are banned).

**NAME-2.** Work records are **pages**, not cards. The four deliberate
survivors of the rename (`cards` SQLite table, `unblocked_cards` frontmatter,
`GRIMOIRE_CARDS_DIRECTORY`, and the `?card=` link parameter old share links still
carry) are documented exceptions; no new code — and no user-facing copy — says
"card". "Card" as a CSS class for a tile-shaped UI element (`idea-card`) is a
different word and stays.

**NAME-3.** A name says what a thing is, not how it is implemented.
`seenCursor`, not `seenCursorMap`; `restorePage`, not `handleRestoreClick2`.

## 4. Server

**SRV-1.** Validation is strict and at the edge. Every request body is
validated before any effect; unknown fields are rejected, not ignored. A parse
failure names the exact field and, for files, the exact path.

**SRV-2.** Security defaults: secrets stored only as sha256 hashes;
capability decisions are allow-lists, never deny-lists spread through routes; rate
limits are token buckets in memory; nothing ever builds HTML from user text.

**SRV-3.** Errors are refused loudly at the boundary with the right
status code and a body the client can act on (`409` + `conflict: true` + the stored
record). No route swallows an error into a generic 500 when it knows more.

**SRV-4.** A route handler reads like a table of contents: authenticate,
authorize, validate, act, log, respond. Business logic longer than a screen lives in
a named function in a domain module, not inline in the route.

**SRV-5.** `server/app.ts` is route *registration*, not route
*implementation*. Target: no handler body over ~40 lines in app.ts; the file itself
under ~500 lines once split along its existing section seams.

**SRV-6.** SQL lives beside the domain it serves, is written as plain
statements (no query builder), and migrations are guarded so they run once and are
no-ops afterwards.

**SRV-7.** Every mutation appends to the activity log with actor, entity,
and readable field changes — except pure reorders, which are deliberately silent.

**SRV-8.** No unguarded I/O after the checks: a stream piped to a response
carries an `'error'` listener, a write to a long-lived socket (SSE, keep-alive timer)
is guarded, and nothing that can throw runs after the response has been sent. An
uncaught exception on a later tick takes the process down, and the error funnel
cannot see it.

**SRV-9.** A docstring that claims atomicity is a contract. A multi-file
operation either gets the transaction its comment promises, or the comment says
plainly what a crash in the middle leaves behind.

## 5. Client

**UI-1.** Nothing pops in. A box that changes size travels to its new
size via `<Growing>` / `useHeightSwap`; 190ms on `cubic-bezier(0.2, 0.7, 0.2, 1)`;
all motion is skipped under reduced-motion. `CLAUDE.md` is the authority, including
its two exemptions (entering dialogs, query-tracking lists).

**UI-2.** The server's answer is the truth. After a mutation the client
reloads canonical state; live updates invalidate and reload rather than merging
patches.

**UI-3.** `App.tsx` owns session and routing state only. Workspace state
lives in the workspace that uses it; a prop that travels through three components
untouched is a sign the state is homed wrong.

**UI-4.** A component file holds one component and its private helpers.
Target: no component file over ~400 lines; extraction seams are subcomponents with
their own props, not booleans that switch one big render.

**UI-5.** Accessibility is not a pass at the end: interactive elements
are buttons, expanded state is `aria-expanded`, dialogs trap and restore focus,
escape closes via `use-dialog-escape`.

**UI-6.** CSS stays in `src/styles.css` (no CSS-in-JS, no modules), but
the file is organized in labeled sections matching component names, and a class
removed from the last TSX file is removed from the CSS the same day. Values repeated
more than twice — the pill radius, the accent border, transition timings — become
`:root` tokens beside the fourteen colours that already are.

**UI-7.** All HTTP goes through `src/api/client.ts`, and all mutations go
through the `perform` family in `App.tsx` — that is what keeps `busy`, error surfacing,
and the reload-after-write contract true everywhere. A bare `fetch` or a direct
`mutate` call from a component is a hole in that contract.

**UI-8.** Effects follow the codebase's own best patterns: URL writes
happen in the event handler that changed the state, not in a sync effect; every
async loader carries the `alive` unmount guard; layout reads-then-writes use
`useLayoutEffect`. Each of these already has a majority pattern in the code — the
standard is that the minority converts.

## 6. Testing

**TEST-1.** Tests exercise the real thing: server tests go through real
routes with a real store on a temp directory; the import script's output is loaded
through the real `MarkdownPageStore`. Mocks are for genuinely external services only.

**TEST-2.** Test names are sentences about behavior, not method names:
what a reader would need to believe before deleting the test.

**TEST-3.** Every server module with behavior gets a test file; every
bug fix lands with the test that would have caught it. New routes are not merged
untested.

**TEST-4.** The e2e suite covers each *journey* once (sign in, create,
move, edit-with-conflict, archive-and-undo); everything else belongs in the faster
suites. E2E is run locally before a release — never in paid CI.

**TEST-5.** Test harness code lives in `tests/fixtures/`, once. A helper
defined verbatim in a second test file moves there the day the second copy appears.
Fetch stubs are URL-keyed routers, never ordered queues — an ordered queue breaks
unrelated tests when any component gains a background request.

**TEST-6.** Security policies are tested as policies, not as examples: the
agent allow-list test proves a route not on the list is refused (closed by default),
not merely that twenty known routes are.

## 7. Dependencies

**DEP-1.** The dependency list stays short enough to read — that is a
selling point of self-hosting Grimoire, and it is why OIDC is written on Node's own
crypto. A new dependency needs a reason its absence costs more than its presence,
stated in the PR.

**DEP-2.** No dependency for what the platform does: `fetch`, `crypto`,
`fs/promises`, `URL`, `AbortController` are already here.

## 8. Comments and docs

**DOC-1.** Comments state what the code cannot: constraints, invariants,
and the reason a surprising choice is right. No comment narrates the next line, and
no comment addresses a reviewer.

**DOC-2.** Commit messages are conventional-commit shaped with a human
subject: `feat(auth): give Google its own button, to Google's specification`. The
subject says why it matters, not which files moved.

**DOC-3.** `docs/architecture.md` is updated in the same PR as the
behavior it describes. A PR that changes a documented decision without touching the
doc is incomplete.

## 9. Tooling

**TOOL-1.** Formatting is mechanical: Prettier, as a devDependency, checked by
`npm run check` — so outside contributors can match the house style without
absorbing it first. No ESLint for now; that stays a deliberate choice (DEP-1), and
the stale `eslint-disable` comments that reference a linter the repo doesn't have
are removed rather than honoured. Revisit the linter question when outside
contributions start arriving.

---

## Additions

<!-- New standards go under their section above, or here when none fits; give each
     an ID and the next audit pass will measure the codebase against it. -->
