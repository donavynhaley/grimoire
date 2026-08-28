# Code audit — August 2026

The diff between the codebase and `docs/coding-standards.md`, taken before launch.
Every finding cites the standard it falls short of (`SRV-8`) and carries an ID
(`A1`) so a fixing PR can name what it closes. Line numbers are as of `main` at
`4ffd5bf`.

Severities:

- **launch-blocker** — a crash, a security hole, or a wrong answer a user can hit.
- **pre-launch** — worth fixing before strangers run this, but nobody dies.
- **debt** — schedule it; launching with it is fine.

## The verdict

This is a disciplined codebase. There is no `as any`, no `@ts-ignore`, no TODO
anywhere in ~23,000 lines; validation is strict at every boundary including the
team's own files on disk; secrets exist only as hashes; the error funnel, the
injectable I/O seams, and the comment-as-design-record voice are all better than
what most teams ship. The architecture doc is the best artifact in the repo.

The shortfall is concentrated, not diffuse:

1. **A handful of real bugs**, three of which can kill the process (§A).
2. **Three files that never grew the structure the rest of the code has** —
   `server/app.ts` (2,890 lines, one closure), `server/repository.ts` (1,578),
   `src/components/Board.tsx` (1,131) (§F).
3. **Copy-paste families**: the four Markdown stores are ~60% identical, the type
   contract is restated in five places, and the client repeats the same nine UI
   patterns (§D).
4. **The API client is the one untested file** — and it is where two of the bugs
   live (§A5, §A6, §G1).

Everything in §A was verified by hand against the source, not just reported.

---

## A. Fix before launch

**A1 — Unguarded stream pipes can crash the server.** *(SRV-8)* — **launch-blocker**
`server/app.ts:978` (avatars), `server/app.ts:1010` (project images),
`server/app.ts:2881` (`serveFile`, every static asset). All three do
`createReadStream(path).pipe(response)` with no `'error'` listener. A file
removed or made unreadable between the `existsSync` check and the read emits an
unhandled `'error'` on a later tick — outside the error funnel — and that is an
uncaught exception that takes the process down. Fix: one shared
`sendFile(response, path, contentType)` that attaches an error handler (destroying
the response), used in all three places.

**A2 — Unguarded SSE writes.** *(SRV-8)* — **launch-blocker**
`server/app.ts:1779` (keep-alive `setInterval` writing to every stream),
`server/app.ts:2644` and `:2661` (`broadcast` / presence writes). A write to a
half-closed socket can throw; the keep-alive throw happens in a timer callback with
no handler above it. Fix: wrap the write, drop the client on failure — which also
makes presence more accurate.

**A3 — Bootstrap race can create two admins.** *(SRV-2)* — **launch-blocker**
`server/app.ts:681-706`. `userCount === 0` is checked, then `await readJson`,
then checked again, then `await hashPassword`, then a bare INSERT — no
transaction, and the second check still yields to the event loop before the
INSERT. Two concurrent `POST /api/auth/bootstrap` requests can both pass both
checks and both insert an admin, on the one route whose whole purpose is "exactly
one admin, ever." The register route does this correctly 300 lines below
(`UPDATE … WHERE used_by IS NULL` + a `changes` assertion, `:1041`). Fix: a
uniqueness the database enforces — e.g. INSERT guarded by
`WHERE NOT EXISTS (SELECT 1 FROM users)` inside a transaction, asserting
`changes === 1`.

**A4 — Login timing oracle.** *(SRV-2)* — **pre-launch**
`server/app.ts:724-726`. For an unknown email the code runs
`verifyPassword(pw, await hashPassword("invalid password placeholder"))` — **two**
scrypt derivations against one for a real account. The dummy-hash trick is meant to
equalize timing and here roughly doubles it, making account existence measurable.
Fix: hash the placeholder once at module load and reuse it. (`signInWithIdentity`
at `:2512` already gets this right.)

**A5 — The web client crashes on any non-JSON error response.** *(SRV-3, UI-7)* — **launch-blocker**
`src/api/client.ts:53` calls `await response.json()` unconditionally, before
checking `response.ok`. A 502 HTML page from a reverse proxy, or any empty body,
throws a raw `SyntaxError` that is not an `ApiError` — so `editConflict()` returns
null, every `instanceof ApiError` branch is bypassed, and the user sees a generic
failure with no detail. The MCP client already solves this correctly
(`response.text()` then guarded parse, `packages/grimoire-mcp/src/client.ts:177`).
Fix: port the MCP approach inward.

**A6 — `setThreadAnswered` types away a null the server can send.** *(TS-4)* — **pre-launch**
`src/api/client.ts:106-115` promises `{ thread: DiscussionThread }`;
`server/app.ts:2119` sends `thread: result === "unchanged" ? findThread(…) : result`,
and `findThread` is documented to return null (`server/discussion.ts:125`). Setting
a thread to the state it already holds while it vanishes hands the UI a null it
will dereference. Fix: 404 on the server when `findThread` misses; type stays.

**A7 — One inconsistent page file 500s the whole board.** *(SRV-3, ARCH-3)* — **pre-launch**
`server/repository.ts:1221`: `publicPage` throws a bare `Error` when a page names
an assignee who is no longer a member, and `getBoard` calls it for every page — so
one odd file turns the entire board into "Internal server error" with nothing
naming the file. The parser's own standard (SRV-1: name the exact file) is right
there. Fix: treat an unknown assignee as unassigned (the same grace
`publicChapter` already shows at `:1344`), or fail with the page id and path in
the message.

**A8 — Multi-file operations claim an atomicity they don't have.** *(SRV-9, DOC-1)* — **pre-launch**
`server/repository.ts:1459-1462`: `closeChapter`'s docstring says "together or
none of it happens," but the body is a bare loop of `pageStore.save` (`:1502`)
then `chapterStore.save` (`:1520`) — no transaction, no rollback. The same shape:
`deleteCategory` (`:356` — DB row deleted *before* the N file writes),
`deleteField` (`:492`), `deleteChapter` (`:733`), `updateField` (`:467`),
`removeProjectMember` (`:1177` — assignees cleared on disk *before* the
membership transaction opens). Fix per SRV-9: order writes so a crash leaves a
recoverable state (files first, DB row last, since the board tolerates a stray
value better than a missing definition), and make the docstrings tell the truth.

**A9 — Broadcast-after-response can turn success into a phantom 500.** *(SRV-8)* — **pre-launch**
`server/app.ts:946`, `:957`, `:965` (and the pattern generally): `json(...)` is
sent, then `broadcast(requireProject(context, user), …)` — `requireProject` can
throw after the reply went out; the funnel's `json()` no-ops on `headersSent`, so
the client sees success while the server logs an uncorrelatable 500. Fix: resolve
the project before responding.

**A10 — Static path traversal guard depends on an unstated invariant.** *(SRV-2)* — **pre-launch**
`server/app.ts:2848-2860`: `resolveStaticPath` strips `../` prefixes *before*
stripping the leading slash, so `/%2e%2e/…` survives the first replace and is
only saved by Node's `normalize` dropping `..` from absolute paths — an invariant
the code neither states nor tests. Fix: resolve then assert containment with
`path.relative` (no `..` in the result), and add the traversal test.

**A11 — Escape closes three dialogs twice.** *(UI-5)* — **pre-launch**
`BacklogDialog.tsx:57-65`, `DoneHistoryDialog.tsx:39-47`, `ActivityDialog.tsx:49-57`
each add their own window keydown listener calling `onClose()` — but `Drawer`
already installs `useDialogEscape(onClose)` (`Drawer.tsx:50`), so every Escape
fires `onClose` twice. Harmless today only because closing twice is idempotent;
it breaks the moment close has a side effect. Fix: delete the three local
listeners.

**A12 — Two loaders can set state after unmount / lose a draft.** *(UI-8)* — **pre-launch**
`AgentAccessSection.tsx:30-41`: the only async loader in the codebase without the
`alive` unmount guard every other loader carries. And `PageFields.tsx:29-30`
keeps one shared `editingKey`/`draft` pair for all fields, so starting to edit a
second field silently discards the first field's unsaved draft.

**A13 — The admin gate rests on an unchecked cast.** *(TS-2)* — **pre-launch**
`server/repository.ts:53`: `role: value.role as User["role"]` straight out of
SQLite — the value that `requireAdmin` gates on. `server/app.ts:2544` similarly
casts `Record<string, unknown>` to `Record<string, string>` on the OIDC sign-in
path. Both are one honest runtime check away from sound.

## B. Guardrails before refactoring

Do these before the big splits in §F — they are what makes those splits safe.

**B1 — Turn on `noUncheckedIndexedAccess` in the root tsconfig.** *(TS-3)*
It is already on in the MCP package and off in the 11k-line app — backwards. The
unguarded `match[1]` indexing it would catch feeds authorization checks
(`server/app.ts:1296`, `:1305`, `:1318`, `:2397`). Expect a day of adding guards;
each one is a real `undefined` case. Add `noImplicitOverride` (free today) at the
same time. `exactOptionalPropertyTypes` breaks `packages/grimoire-mcp/src/index.ts:36`
first — take it separately or not at all.

**B2 — Test `src/api/client.ts` directly.** *(TEST-1, G1)*
It is the one file with zero tests, every UI test stubs fetch underneath it, and
both A5 and A6 live in it. A dozen tests against a stubbed `fetch` — error
parsing, conflict decoding, non-JSON bodies, header attachment — locks the fixes
in.

**B3 — Prove the agent allow-list is closed by default.** *(TEST-6)*
`tests/server/agent-access.test.ts:285,308` enumerates 20 refused routes; a write
route added to `app.ts` tomorrow is not caught. Add a test that walks the route
table (after F1 creates one) — or, until then, one that hits an unregistered
plausible path and asserts 403 — so "closed unless opened" is a tested property,
not a stated one.

**B4 — Decide TOOL-1 (linter/formatter).**
Two stale `eslint-disable-next-line react-hooks/exhaustive-deps` comments
(`PageDialog.tsx:133`, `MarkdownEditor.tsx:182`) reference a linter the repo
doesn't have, while a third identical case (`IdeasBoard.tsx:45`) carries nothing.
Whatever the decision, it settles which of those three is correct. Prettier alone
is the smallest move that helps outside contributors before open-sourcing;
typescript-eslint with `react-hooks` rules would also have flagged
`Board.tsx:312`'s `useKeyboardShortcut` (a plain handler named like a hook).

**B5 — Add a coverage report.** *(TEST-3)*
`vitest.config.ts` has no coverage block; none of §G's claims can be watched
without one. Config-only change.

## C. Dead code — delete first, so nothing below refactors a corpse

**C1 — The `MarkdownView` subsystem.** *(UI-4)* `NotesField.tsx:10-39`
(`MarkdownView`, `ExternalLink`, `EmbeddedImage`, `MARKDOWN_COMPONENTS`,
plugin lists — its own comment says the notes field no longer uses it), all of
`obsidian-embeds.ts` (46 lines) and `markdown-source-offsets.ts` (78 lines,
implementing a rendered/editor swap the product no longer has), the
`.markdown-body` CSS block (`styles.css:2334-2375`). Removing the chain makes
**`react-markdown` and `remark-gfm` removable dependencies** (DEP-1 win). Verify
against `tests/` before deleting — the survey only proved no importer in `src/`.

**C2 — Server strays.** `userIsProjectMember` (`repository.ts:190` — exported,
imported, never called; the route it documents calls `userOwnsProject` instead),
`comparison()` (`recap.ts:20-31` — never called, returns hardcoded zeros), and
`recap.ts:69`: `pages.filter((page) => page.status !== "done" || true)` — a
tautology; write `pages` and say so, or restore the filter that was meant.

**C3 — MCP strays.** *(TS-4)* `GrimoireClient.page()`
(`packages/grimoire-mcp/src/client.ts:219`) was built, the server allow-list was
opened for it with a comment about avoiding megabyte board pulls
(`app.ts:412-415`), and it was never wired — every MCP page read still fetches
the whole board. Wire it (it's a perf fix, not just cleanup). `Page.openThreads`
(`client.ts:41`) is declared and surfaced nowhere — an agent cannot see the open
questions the tool descriptions tell it to answer; surface it in `renderBoard`.
`hits[].category` (`client.ts:121`) declared, never rendered.

**C4 — CSS strays.** *(UI-6)* `.assignee.assigned` (`styles.css:1602`, no-op),
`.discussion-open` (`:4413`, no emitter), `.team-error` (`:2640`, superseded),
`.notes-view` (referenced from `NotesField.tsx:217`, no rule exists — a dead
styling hook), and three custom properties used but never defined: `var(--line)`
(`:2588`), `var(--purple, …)` (`:2327`), `var(--green, …)` (`:2328`).

**C5 — Sundry.** `app.ts:845-846` `const user = requireAdmin(context); void user;`;
`MarkdownEditorHandle.value()` (`MarkdownEditor.tsx:18`, never called);
`usePointerDrag(...).dragging` (`use-pointer-drag.ts:288`, never read);
`NotesField.tsx:13`'s pass-through re-export of `resolveImageSource`;
`pages-rename.test.ts` importing `node:fs` and `node:path` twice each. The legacy
`cards` table + migration path and the `/api/cards` alias are **deliberate**
(ARCH-3) — leave them, but the alias's own comment says it can go once every tab
has reloaded; give it a version-numbered eviction note.

## D. Duplication — one implementation per idea

**D1 — The type contract is restated five times.** *(TS-7, TS-4)*
Page status lives in `shared/types.ts:112`, again as literals in the zod enum
(`server/app.ts:247` — while `:341` shows the correct `z.enum(FIELD_TYPES)` idiom
one screen away), again in `audit.ts`'s label table, twice more in the MCP package
(`resolve.ts:23-43`, `server.ts:627`). Same for chapter states (`app.ts:312`),
idea states (`:353`), roles (`:364`), scopes (`:443`). Derive every one from the
shared tuple. Related: the two label tables that disagree — `audit.ts:28` says
"Idea inbox" where `search.ts:21` says "Inbox" for the same list.

**D2 — The MCP package's eight re-declared shapes have drifted.** *(TS-4)*
`packages/grimoire-mcp/src/client.ts:10-124` re-declares `Page` (status widened
to `string`, four fields dropped), `SearchResults` (drops `categoryColor`),
`Board` (a hand-narrowed subset nothing checks). The isolation is deliberate
(HTTP-only, no app imports — keep that); the enforcement is a comment. Options:
generate the subset from `shared/types.ts` at build time, or add a compile-only
type-equality assertion file inside the package that imports shared types as
dev-only. Also: `DISCUSSION_BODY_MAX_LENGTH` is a bare `4000` at MCP
`server.ts:461,503` while `BODY_MAX_LENGTH` got the named-constant-plus-comment
treatment; and the version is hand-synced between the package.json and
`server.ts:60`.

**D3 — The four Markdown stores are ~60% copy-paste.** *(ARCH-6)*
`markdown-pages.ts` / `markdown-ideas.ts` / `markdown-chapters.ts` each reimplement
the constructor-mkdir, the `list()` chain, `readPath()` with the same error shape,
the slug guard (verbatim in four files including `project-images.ts:88`), and the
compare cascade; page and idea `archive/restore` are line-for-line twins. Extract
a base (or shared helpers module) beside `markdown-files.ts`. Likewise
`writeAtomic` is reimplemented in `avatars.ts:56` and `project-images.ts:70`
(with a duplicated magic-byte sniffer) when `markdown-files.ts:46` already
exports the real one.

**D4 — Server helper triplets.** *(ARCH-6)* The transaction boilerplate
(`BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`) is hand-written 11 times — write
`withTransaction(database, fn)`. The splice-reorder algorithm exists four times
(`repository.ts:984`, `:1029`, `:1068`, `ideas-repository.ts:103` et al.). Four
slugifiers differ only in length caps (`repository.ts:298`, `:384`, `:597`,
`database.ts:153`). Invite validation exists at `app.ts:1016` and again as the
unused-by-that-route helper at `:2582`.

**D5 — Client pattern families.** *(ARCH-6, UI-4)* Nine hand-rolled
confirm-in-place blocks (→ one `<ConfirmInline>`; also collapses 6 CSS forks of
`.archive-confirm`). Four outside-click closers (→ `useDismissOnOutside`). Four
status-label maps (`Board.tsx:42`, `PageDialog.tsx:27`, `QuickCapture.tsx:89`,
`page-facets.ts:29` — fold into D1's derived table). Three library-dialog shells
rebuilding the same header/search/people-filter/empty-state
(`BacklogDialog`/`DoneHistoryDialog`/`ActivityDialog`). Board↔IdeasBoard share a
drag-and-drop twin (`IdeasBoard.tsx:57-170` ports `Board.tsx:102-113,503-580` —
→ `useCardBoard`), plus identical `MoveSlot`, ghost overlay, moving bar,
escape-cancels, opened-unseen, and URL-sync blocks. PageDialog↔IdeaDialog copy
the editor scaffolding verbatim (→ `useRecordEditor`). `category-style.ts`
exists and is bypassed by five components that re-inline it.

## E. Consistency — two ways of doing one thing

Each row: the standard-bearer wins, the minority converts. *(mapped standard in
parens)*

- **SQL location** *(SRV-6)*: `app.ts` issues ~20 raw queries for users/sessions/
  invites/projects while everything else lives in repositories. Extract an
  `auth-repository.ts` as part of F1.
- **`changes` check**: `=== 1` in four places, `> 0` in two
  (`repository.ts:1541`, `agent-tokens.ts:122`). Pick `=== 1`.
- **Archived-project guard**: `setChaptersEnabled` has `AND archived_at IS NULL`;
  `setEstimatesEnabled`, `setProjectGithub`, `setProjectRecap` don't — settings
  writable on archived projects. Add the guard.
- **Missing-creator policy**: `publicPage`/`publicIdea` throw, `publicChapter`
  degrades. A7 settles this: degrade, everywhere.
- **Error shape** *(SRV-3)*: `/api/auth/oidc/probe` answers 200-with-`{error}` —
  the only route that does; `/api/search`, `/api/activity`, `/api/away` return
  unwrapped payloads where every other route wraps in a named key.
- **Query parsing**: zod for search, hand-rolled for activity, `.slice(0,100)`
  for events. Zod for all three.
- **Chapter preconditions**: pages and ideas take `expectedTitle` +
  `expectedDescription`; chapters only the latter, unstated why.
- **URL writes** *(UI-8)*: filter params are written from setters (correct);
  `?page=`/`?idea=`/`?settings=` are synced from effects. Convert.
- **Prop-seeded state**: three competing patterns; the `drafts[key] ?? prop` map
  (CategoriesSection et al.) is the correct one — `ProjectSettingsDialog`'s and
  `AccountDialog`'s seed-once fields go stale on live updates.
- **Reads as props vs direct imports** *(UI-7)*: `onLoadActivity`/`onLoadDiscussion`
  are threaded as props while five components import their reads directly. Direct
  import wins for reads; writes stay on `perform`.
- **Client contract breaches** *(UI-7)*: `AccountDialog.tsx:74` bare `fetch`;
  `ProjectSettingsDialog.tsx:300` direct `mutate` that bypasses `busy` and the
  refresh contract.
- **Handler naming** *(NAME-3)*: `Board.tsx:312` `useKeyboardShortcut` (a plain
  handler wearing a hook name — rename first, it will trip any future lint),
  one `handleInputKeyDown`, one `onKeyDown` local; the house style is a bare verb.
- **Escape contracts** *(UI-5)*: three variants exist; `use-dialog-escape` +
  `defaultPrevented` guard is the house rule (see A11).
- **`EditorState` name collision**: `src/components/EditorState.tsx` vs
  CodeMirror's `EditorState` one import away — rename the component (it renders
  the autosave line; `SaveState` says it).
- **"Nothing pops in" holdouts** *(UI-1)*: `AgentAccessSection` (secret block,
  revoke confirm), `ProjectMenu.tsx:115` (create form swap), `Board.tsx:893`
  (column add-form swap), `AccountDialog.tsx:176` (avatar editor),
  `DiscussionSection.tsx:85` (answered-threads reveal), `Board.tsx:654`
  (AwayDigest dismiss).
- **A11y odds and ends** *(UI-5)*: `Drawer` claims `aria-modal` but never traps
  or moves focus in; `QuickCapture` puts `role="option"` on buttons inside the
  listbox against the codebase's own documented rule
  (`DiscussionSection.tsx:404`), and its `aria-selected` disagrees with
  `aria-activedescendant`; `ChapterPicker` uses `role="menu"` with no arrow keys
  where `PageFilters` uses `role="dialog"` for the same shape; `Board.tsx:829`
  builds 300-character `aria-label`s; the autosave line announces on every pause.

## F. The big splits

**F1 — `server/app.ts` (2,890 lines).** *(ARCH-6, SRV-5)* One closure
(`createGrimoireServer`, lines 448-2696) holding one 1,581-line if-chain
(`handleApi`). The seams are already contiguous:

| Move first (zero risk, ~440 lines) | |
|---|---|
| `194-446` | request schemas + `agentMayReach` → `schemas.ts`, `agent-policy.ts` (pure) |
| `2698-2890` | `readJson`/`json`/cookies/CSP/static → `http.ts` (pure) |

| Then, one PR per group, threading a context object | |
|---|---|
| `652-1055` | auth, OIDC, account → `routes/auth.ts` |
| `1109-1337` | invites + projects → `routes/projects.ts` |
| `1339-1546` | tokens, categories, fields → `routes/project-config.ts` |
| `1548-1684` | chapters → `routes/chapters.ts` |
| `1686-1762` | members → `routes/members.ts` |
| `1764-1834` | SSE + activity + away → `routes/activity.ts` |
| `1836-1993`, `2125-2205` | board, search, pages, ideas → `routes/board.ts`, `routes/pages.ts`, `routes/ideas.ts` |
| `1995-2123` | discussion → `routes/discussion.ts` |
| `2421-2683` | OIDC helpers, sessions, broadcast → `auth-service.ts`, `sessions.ts`, `events.ts` |

Two things the flat if-chain currently hides, worth fixing during the split: the
route-shadowing trap (`GET /api/projects/archived` at `:1283` survives only
because nothing above matches `GET /api/projects/:id`), and the ~15 inline route
regexes re-built per request. A tiny route table (method, pattern, handler,
agent-open flag) fixes both and gives B3 its enumerable list.

**F2 — `server/repository.ts` (1,578 lines).** Already grouped contiguously
(the banner comments at `:1382`, `:1448` mark seams the author saw). Split into
`repository/{projects,pages,chapters,fields,members,serialize}.ts`. Extract
`auth-repository.ts` from app.ts's stray queries at the same time (§E).

**F3 — `Board.tsx` (1,131 lines, 37 props).** Extraction order by payoff:
`<PageTile>` (`811-885`, the densest block), `<BoardDialogs>` (`927-1044` —
removes the 14 props Board only forwards), `useCaptureFlight` (`425-484`),
`useBoardDragAndDrop` (`503-580`, twin lives in IdeasBoard — do with D5's
`useCardBoard`), `useBoardFilters` (`166-208`, `265-304`, `349-411`),
`<BoardTopBar>`/`<WorkFilters>`, `useBoardShortcuts`.

**F4 — The other three.** *(UI-4)* `ProjectSettingsDialog.tsx`: four inline
sections (`Discord` 276-406, `Github` 408-551, `General` 553-619, `Danger`
630-705) join the six that already live in their own files — no design work, and
it fixes the two orphaned doc comments at `:262`/`:268`. `PageDialog.tsx`: move
`usePageHistory`/`usePageDiscussion` to `use-*.ts` files (NAME-1), extract
`<PageRail>` (`306-522`) and `PageHistory`; `EstimateRow` belongs in
`PageFields.tsx`. `App.tsx`: `useLiveEvents` (`102-159`), `useAwayState`,
`useWorkspaceActions` (`165-484`, splits four ways), `applyOptimisticPageUpdate`
→ `optimistic-page.ts` (pure, then B2-style testable). `QuickCapture.tsx`:
`usePicker`, `<CapturePicker>`, move the pure tail (`450-598`) to
`capture-pickers.ts`.

**F5 — `shared/types.ts` (648 lines) and `src/styles.css` (4,647 lines).**
Types: mechanical split into `domain.ts` / `api.ts` / `limits.ts` — the file
currently mixes persisted domain types, response envelopes, validation
constants, two runtime functions, and a color palette. CSS: 36% of the file
(lines 1-1671) has no section banners; add them, collect the 11 scattered
`max-width: 620px` blocks and 7 reduced-motion blocks, and add the missing
tokens (UI-6): the pill radius written out ~25 times, `#465f3c` ~12 times, the
transition timings that JS already centralizes in two constants.

## G. Test debt

**G1 — Untested load-bearing code.** *(TEST-3)* `src/api/client.ts` (B2);
`live-preview.ts` (618 lines, only exercised through jsdom where every box is
zero — its geometry paths are dark; the e2e spec checks two invariants);
`repository.ts` (one direct-import test); `Growing`/`use-height-swap`/`use-flip`
(the CLAUDE.md rule, enforced by nothing); `use-dialog-escape`,
`markdown-source-offsets` (moot if C1 deletes it).

**G2 — Harness duplication.** *(TEST-5)* `response()` defined verbatim in 13 of
21 UI files; the `afterEach` block in ~15; `mountWith()` three times;
`beginSignIn`/`callback` twice; `shellDirectory()` three times; the member
constants six times. Move to `tests/fixtures/`. Convert `app.test.tsx` and
`edit-safety.test.tsx` off the *ordered* mock queue to the URL-keyed router the
other files already use — the queue silently breaks unrelated tests whenever any
component gains a background fetch.

**G3 — Speed.** All 332 server tests call `startTestServer()` inside the `it()`
body — fresh temp dir, SQLite, migrations, socket per test. Even
per-`describe` reuse with a reset would take the biggest cost out of `npm test`.

**G4 — MCP package.** No test framework; `verify-e2e.mjs` is a bespoke 500-line
harness (that does boot the real thing). When D2's contract work lands, give the
package a vitest suite so the type-equality assertions have somewhere to live.

---

## The plan

Ordered so every phase makes the next one safer. One PR per numbered item;
sizes are S (≤half a day), M (a day or two), L (several days).

**Phase 0 — Sign-off (you).** Edit `docs/coding-standards.md`: strike or amend
the proposed standards, answer TOOL-1 and the size-target question, add your own.
The audit is re-runnable against the edited ruler.

**Phase 1 — Launch blockers (S each, independent).**
A1 `sendFile` with error handling · A2 guarded SSE writes · A3 bootstrap
transaction · A5 client response parsing (port from MCP) — then A4, A6, A7, A9,
A10, A11, A12, A13. All of Phase 1 is a week of small PRs, each with the test
that would have caught it (TEST-3).

**Phase 2 — Guardrails (mostly S).** B1 tsconfig flags (M — a day of honest
guards) · B2 api-client tests · B3 allow-list closed-by-default test · B4 linter
decision + apply · B5 coverage. Plus A8's docstring honesty pass (S) with the
write-ordering fix (M).

**Phase 3 — Dead code (S).** C1 MarkdownView chain (+2 dependencies gone) · C2
server strays · C4 CSS strays · C5 sundries. C3 (wire MCP `page()`, surface
`openThreads`) is M and worth doing now — it's a live perf and agent-usability
fix.

**Phase 4 — One implementation per idea (M each).** D1 derive-from-tuple ·
D4 `withTransaction` + reorder + slugify + invite helpers · D3 Markdown store
base · D5 client families (`ConfirmInline`, `useDismissOnOutside`,
`useCardBoard`, `useRecordEditor`, library-dialog shell) · E consistency
sweep (one PR per row is fine; most are S). D2 MCP contract enforcement (M).

**Phase 5 — The splits (L, one seam per PR).** F1 app.ts (zero-risk moves
first, then route groups, route table last) · F2 repository split +
auth-repository · F3 Board extractions · F4 the other three · F5 types + CSS
organization. The test suite you already have is what makes these safe; G2's
harness consolidation (M) is worth doing before F3 so the UI-test churn is
cheap. G3 (M) any time.

**What this buys before launch:** Phase 1 removes every known crash and race.
Phases 2-3 make the codebase honest about what it enforces and drop two
dependencies. Phases 4-5 are what make the feature list you're about to build
cheap — every new route, dialog, and field type currently pays the copy-paste
tax; after D and F they pay it once.
