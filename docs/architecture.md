# Grimoire architecture

Grimoire is a collaborative visual editor for a directory of Markdown work pages and ideas.
The Markdown files are the canonical project record, not an export or cache of database rows.

## Storage boundary

SQLite stores operational collaboration data:

- User accounts and password hashes.
- Browser sessions.
- Invitation records.
- Agent credentials, as hashes, with the project and person each one acts for.
- Project identity and membership.
- The append-only project activity log.
- Each member's private last-seen cursor into that log.

The configured project directory stores all work page and idea domain data:

- Title and board status.
- One optional game-development category.
- Links to pages that block other pages.
- Ordering within a status.
- Assignment and authorship.
- Creation, update, completion, and archival timestamps.
- The Markdown notes body.
- Chapter membership, and the chapters themselves: name, state, time frame, and intent.
- Idea state and manual rank.
- The link from an archived idea to its promoted work page.
- Temporary dependency restoration metadata for reversible page archives.

This boundary keeps authentication private while allowing project work to remain readable, diffable, and portable.

The activity log records who acted rather than what the work is, so it belongs with accounts and membership rather than with the pages.
Keeping it out of the Markdown also avoids adding a Git diff to every page move.
It is a deliberate consequence that a copied project directory carries the work but not its history.

The while-you-were-away digest is one row per member per project in `seen_cursors`: the newest `audit_events.sequence` that member has seen while their tab was visible.
Everything the returning reader is shown - the digest, the page and idea markers, the owner's badge and unread line - derives from the events after that cursor, with the reader's own actions excluded at the query.
Advances are MAX-guarded and clamped to the newest real sequence, so racing tabs, repeats, and stale requests can never rewind or overshoot the boundary, and a first look pins the cursor to the present so joining never dumps history as unread.

Only the newest unused invitation created by the owner remains valid, and a successful registration consumes it atomically.
Removing a member deletes their project membership, active sessions, live event streams, and seen cursor, and clears their assignments from the Markdown pages.
Their user identity remains in SQLite so pages they created continue to show accurate authorship history.

## Naming

Work records are **pages**. They were called cards until the vocabulary was brought in line with
the rest of the product, and the rename reaches the interface, the API, the type names, and the
per-project directory on disk.

Three things deliberately keep their older names:

- The legacy SQLite `cards` table, which exists only as a one-way migration input from earlier
  versions. Renaming it would break migration from an install that never ran the newer code.
- The `unblocked_cards` frontmatter key, which is transient metadata on archived files only.
- The configured root directory, whose value is a storage location the operator chose. The
  variable is now `GRIMOIRE_PAGES_DIRECTORY`, `GRIMOIRE_CARDS_DIRECTORY` is still honoured, and
  neither default changed - repointing a live instance at a new empty path would be
  indistinguishable from losing the project.

`/api/cards` continues to answer as an alias for `/api/pages`, so a browser still running the
previous bundle cannot have an in-flight save turned into a 404 by a deploy.

## Directory layout

`GRIMOIRE_CARDS_DIRECTORY` selects the root directory.
Each project receives a directory based on its stable slug.
Active and archived records are separated without changing their stable filenames.

```text
pages/
  wizard-simulator/
    pages/
      8b09c17f-8a5e-49f7-99a7-6f0dc7028b47.md
    archive/
      1a42ed21-1f61-4317-b987-d0487515c25a.md
    chapters/
      first-brew.md
    ideas/
      30981e89-3615-45bb-b25b-e544266502fa.md
      archive/
        4ed8f3c6-8e24-4386-8508-a28275c9f178.md
    images/
      pasted-image-20260807-183045-ab12.png
```

Filenames use record UUIDs so changing a title does not create Git rename noise or break references.
Chapters are the exception: their slug is fixed at creation and survives renames, there are few of them, and a readable directory listing is worth more than uniformity.

Images pasted into notes are stored once per project in `images/` and embedded with Obsidian's `![[name]]` syntax.
Embeds resolve by file name rather than by relative path, so a page keeps its images through archive and restore, and an idea keeps them through promotion.
The web application serves the same files through an authenticated project-scoped route, and a vault or repository that contains the project directory renders them natively in Obsidian.
Uploads are verified by content signature (PNG, JPEG, WebP, or GIF), written atomically with generated names, and never deleted by the application.

## Notes editing

Notes are edited on a CodeMirror surface that is always rendered, which is Obsidian's Live Preview rather than a preview pane beside a source pane.
`src/components/live-preview.ts` walks the parsed Markdown tree and hides the syntax that produced formatting, except on the lines the selection touches; an unfocused editor reveals nothing, because notes nobody is writing in are notes someone is reading.
Everything is decided from the tree rather than from text patterns, so syntax inside code stays literal, exactly as `remarkObsidianEmbeds` already treats embeds.

Obsidian's `![[name]]` embeds are not Markdown and no parser reports them, so they are found in the text and then disqualified wherever the tree says Markdown has stopped applying.
Tables and horizontal rules are replaced as whole blocks, which is why the decorations live in a state field rather than a view plugin: block replacements change how tall a line is, and CodeMirror only accepts them from the state.

Nothing in the editor ever builds HTML from note text.
Widgets are constructed element by element, so a note containing markup still shows that markup as characters, which is the same guarantee the read-only renderer gives by never enabling raw HTML.

The surface is a controlled field with the same value-and-`onChange` shape the textarea had, so the autosave and conflict handling in `use-content-editor.ts` are unchanged.
A controlled value arrives a render late, by which time the document has usually moved on, so the editor keeps the short list of texts it has announced and treats a match as its own writing coming back rather than as an edit from elsewhere.

`MarkdownView` remains the read-only renderer for surfaces that only ever display Markdown, and board and library tiles still reduce notes to plain text.

## Page format

Every page contains strict YAML frontmatter followed by its Markdown notes.

```md
---
id: 8b09c17f-8a5e-49f7-99a7-6f0dc7028b47
title: Create the potion workbench
category: code
blocked_by: ["3c651c53-a350-4a01-850c-12242b01e60d"]
status: in_progress
position: 2
assignee: owner@example.com
created_by: owner@example.com
created_at: "2026-08-03T14:20:00.000Z"
updated_at: "2026-08-03T16:45:00.000Z"
completed_at: null
---

Build the first interactive version of the potion workbench.

## Acceptance notes

- Player can place ingredients.
- Failed combinations produce sludge.
- Results can be collected.
```

The supported status values are `backlog`, `ready`, `in_progress`, and `done`.
The interface presents `ready` as Up Next and keeps `backlog` outside the three-column active board.
Done displays the eight newest completions while the history view reads every `done` page from the same canonical set.
The supported category values are `design`, `code`, `modeling`, `texturing`, `animation`, `narrative`, `audio`, `ui`, `vfx`, and `production`.
The `category` value can be `null`, and older files without the field are treated as uncategorized.
The `blocked_by` value is an inline array of page UUIDs, and older files without the field are treated as having no dependencies.
The `chapter` value is a chapter slug and is written **only when the page belongs to one**, which is a compatibility decision rather than a stylistic one - see below.
Older files without the field are treated as belonging to no chapter.
Chapter membership is deliberately independent of `status`, so a page can be in the Backlog and in a chapter at the same time.
A page is blocked while at least one referenced page is not `done`.
Self-links, missing pages, duplicate links, and dependency cycles are rejected.
An unfinished page cannot be archived while unfinished work depends on it.
The `position` value is a zero-based integer within that status.
The `assignee` value is either a project member email or `null`.
The `created_by` value is the creator email.
The `completed_at` value is set when a page enters `done`, remains stable while that completed page is edited, and returns to `null` when the page is reopened.
Older `done` pages without `completed_at` use their last update time as a backward-compatible completion time.
Archived files also contain an `archived_at` timestamp.
When archiving removes dependency links from other pages, the archived file contains their UUIDs in `unblocked_cards` until restoration.
That key keeps its older name deliberately: it is transient metadata on archived files only, and renaming it would make those files unreadable to any build that predates the change for no benefit a reader would ever see.

## Page fields

A project can define properties its own pages carry — a priority, an estimate, a due day — in five primitive shapes: `text`, `number`, `select`, `date`, `checkbox`.
Grimoire names none of them. One project's `select` is a priority and another's is a risk level, and the product has no opinion about which.

Nothing here counts, rolls up, or computes. A `number` field is a number a person wrote down, not an estimate the board adds up behind them, which is the same reason chapters carry no points.

The definitions and the values are stored in different places, and deliberately:

- **Definitions live in SQLite**, in `project_fields`, beside categories. They are project configuration, and a page file carrying its own schema would let two pages disagree about what a field means.
- **Values live in the Markdown**, under one `fields:` key, because they are part of what the page says.

```md
---
id: 8b09c17f-8a5e-49f7-99a7-6f0dc7028b47
title: Create the potion workbench
category: code
fields: {"priority":"p0","estimate":3}
blocked_by: []
status: in_progress
---
```

The key is emitted only when the page has values, so a project that defines no fields keeps byte-identical files to the ones it has now — the same additive rule `chapter:` follows, for the same rollback reason.
`fields` is the one frontmatter value that is a JSON object; the parser accepts a flat map of strings, numbers, and booleans, and rejects nesting, because it is a line-oriented reader rather than a YAML implementation.

A page points at a field by its **key**, which is stable across renames, so relabelling `Priority` to `Urgency` disturbs nothing.
The **type is immutable** once defined: changing it would invalidate every value already stored under it, and the honest repair is the one a person can already do — delete the field and define the one they meant.

Writes are a **patch, not a replacement**. Naming one field leaves every other alone, and `null` clears one. This matters most for agents, which rarely know what the rest of a page holds; a whole-record write would quietly erase everything the caller did not happen to mention. Clearing drops the key, so a page never filled in and one emptied are the same page on disk.

Withdrawing a `select` option, or deleting a field outright, **clears the values it orphaned** and reports how many. The alternative is pages holding a value the project no longer offers, which the next unrelated write to that page would be refused over.

Defining a field is owner-only and closed to agents. Deciding what the project records about its work is the same kind of decision as adding a column; filling one in is refining a page. See [Agent access](#agent-access).

## Chapter format

A chapter is domain data about the work rather than operational data, so it lives in the project directory with the pages it describes.
It has a name, a time frame, and a body saying what the stretch is for, which is why it is a record rather than a row.

```md
---
slug: first-brew
name: First Brew
state: open
position: 0
starts_on: 2026-08-18
ends_on: 2026-09-15
created_by: owner@example.com
created_at: "2026-08-13T09:12:00.000Z"
updated_at: "2026-08-18T08:00:00.000Z"
closed_at: null
---

Get one full potion loop playable end to end.
```

The supported chapter states are `planned`, `open`, and `closed`, and at most one chapter per project is `open`.
The `starts_on` and `ends_on` values are plain `YYYY-MM-DD` days, either may be `null`, and an end before its start is rejected.
They are a day the team named rather than an instant, which is why they are not timestamps.
The `closed_at` value is set when a chapter enters `closed` and returns to `null` when it is reopened, mirroring a page's `completed_at`.
Closing a chapter writes nothing to any page.

Chapters are served only for a project whose `chapters_enabled` column is set.
Turning the gate off hides the interface without deleting a chapter file or clearing a page's `chapter` field, so turning it back on restores the prior state exactly.

## Idea format

Idea files use the same strict frontmatter and Markdown body envelope as pages.

```md
---
id: 30981e89-3615-45bb-b25b-e544266502fa
title: Let familiars learn recurring player habits
state: shortlist
position: 0
created_by: owner@example.com
created_at: "2026-08-03T17:20:00.000Z"
updated_at: "2026-08-03T17:45:00.000Z"
---

The familiar should notice repeated rituals without becoming fully predictable.
```

The supported idea states are `inbox`, `shortlist`, and `parked`.
The `position` value is a zero-based integer within that state and determines the manual shortlist rank.
Ideas deliberately omit assignment and work status fields.
After promotion, the archived idea contains `promoted_to` with the created page UUID and `promoted_at` with the promotion timestamp.

Strings containing YAML punctuation are emitted as double-quoted JSON strings.
Frontmatter arrays use JSON-compatible inline YAML syntax and contain only strings.
Unknown, duplicate, missing, or invalid frontmatter fields are rejected and logged with the exact file path rather than being silently discarded.

## Compatibility with earlier builds

The page schema is strict: an unknown frontmatter key is rejected rather than ignored, and `MarkdownPageStore.list()` reads every file before returning any of them.
Those two facts together mean one unreadable page fails the whole board rather than degrading a single page.

A build that predates chapters therefore cannot read a page carrying `chapter:`.
This is why `chapter` is written only when a page actually belongs to a chapter: a project that never enables them keeps byte-identical files, and a deployment rolled back to an earlier build has to answer only for the pages someone deliberately placed.

Rolling back a deployment that has written chapters requires stripping the key first:

```sh
node ops/strip-chapter-frontmatter.mjs /path/to/pages --apply
```

The script leaves `chapters/` alone, so rolling forward again restores every chapter and only page membership is lost.
Deploying the reader ahead of the writer avoids the problem entirely: the first commit of the chapters work accepts and preserves the field without ever writing it, so releasing that alone gives a rollback target that tolerates chaptered files.

The SQLite side needs no undo.
`projects.chapters_enabled` is additive and defaults to off, so an earlier build ignores it.

## Read and write behavior

Grimoire reads the relevant Markdown directory whenever it loads Work or Ideas.
Edits made outside Grimoire therefore appear on the next refresh of that space.

Every individual file update is written to a temporary file, flushed, and atomically renamed over the prior version.
Archiving atomically moves the stable file into its archive before adding archival or promotion metadata.
Board moves and idea ranking may update several positions, so those multi-file operations are deterministic but not a filesystem transaction.
If positions are duplicated after an interrupted external edit, Grimoire uses creation time and record ID as deterministic tie breakers.

Idea promotion writes the new Backlog page before archiving the source idea.
The archived idea retains the created page UUID as a durable backlink.

## Bulk import

Seeding a project with hundreds of pages through the API would spend the write rate limit and, worse, could half-land: the strict schema means one rejected file fails the whole board, so a partial import is the outcome that must never happen.
The sanctioned path is therefore offline — write the page files directly with the server stopped, then start it.

`ops/import-sample.mjs` is that path for the sample Notion migration.
It reads the project's own categories and field definitions out of SQLite, resolves every row against them, serializes each page, and re-parses the result under the same rules the board loads with.
Only when every row survives does `--apply` write a single file; without it the script reports and writes nothing.

Its map has three sections, differing only in where their pages land: `backlog_pages` go to Backlog with no chapter, since Backlog means accepted but unscheduled and a chapter is a sprint; `as_is_pages` keep the column they had and take the `--chapter` flag; `done_pages` land in Done under the sprint that delivered them, each row naming its own chapter because history spans many.
A per-row `chapter` beats the flag, and a `completed_at` may be supplied where the source system records no completion time — an explicitly-stated proxy orders the Done history, where the import timestamp would make every page identical.

Existing page files are parsed before anything is planned, so an import into an already-broken board refuses rather than adding to the pile, and positions continue from the pages each column already holds.
Each imported body opens with `Imported from Notion task <id>`, which is also the marker a rerun skips on, so the script is safe to run twice.

Ops scripts stay dependency-free, so the serializer and parser there mirror `server/markdown-files.ts` rather than importing it.
`tests/server/import-team.example.test.ts` is what keeps the copies honest: it loads what the script writes through the real `MarkdownPageStore` and the real board route, so a format drift fails the suite instead of a board.

## Activity log

Every change made through Grimoire appends one row to `audit_events`.
Each row records the actor, the entity type and identifier, a title snapshot, an action, and a list of readable field changes.

The recorded actions are `created`, `updated`, `moved`, `archived`, `restored`, `promoted`, `renamed`, `deleted`, `invited`, `joined`, and `removed`.
Pages, ideas, projects, categories, chapters, and team membership are all covered.
Opening or closing a chapter is recorded as `moved`, because that is what a reader scanning the log is looking for.

Adding `chapter` to the `entity_type` CHECK constraint required rebuilding the table, since SQLite cannot alter a CHECK in place.
The rebuild copies `sequence` explicitly and carries the AUTOINCREMENT high-water mark across.
Those numbers are the paging cursor, and every row in `seen_cursors` stores one, so renumbering would rewind or overshoot every member's while-you-were-away boundary.
The rebuild is guarded by inspecting the stored table definition, so it runs once and is a no-op afterwards.
A column change is recorded as `moved` and any other edit as `updated`.

Reordering a page inside one column, or reranking the shortlist, produces no readable change and is deliberately not recorded.
Recording drags would bury real edits under a log shaped by pointer movement.

The actor name and entity title are snapshots taken at write time, so an archived or renamed page still reads correctly in the timeline.
Reads prefer the live account name when it is still available, so renaming an account stays consistent across that person's whole history.

That preference is why an agent's identity is a column of its own rather than a decoration on the actor name.
A write made with an agent credential keeps the issuing person as the actor, and records the credential in `agent_token_id`, which reads resolve to the agent's current name through the same join.
A label folded into the actor name snapshot would be replaced by the live account name on every read, and machine writes would become indistinguishable from that person's own.
Revoking a credential sets a timestamp rather than deleting the row, so history written by a retired agent still says which agent wrote it.
The rebuild above names every column it carries across, including this one, because a rebuild that listed fewer would drop the rest in silence.

Because the log is written by the API, edits made directly to the Markdown files do not appear in it.
The log is append-only, is never pruned, and is scoped to one project on both read and write.
Reads page backwards through a monotonic sequence number rather than a timestamp, which keeps paging stable when several events share a millisecond.

## Discussion

Threads live in `page_discussion` in SQLite, not in the page's Markdown.

A page file is portable and is edited outside Grimoire, so a conversation folded into its body would be rewritten by the first external editor that touched it.
This is the same boundary the activity log draws, and it carries the same cost: discussion does not travel with the Markdown, and does not appear in an Obsidian vault.

One table holds both halves of a thread.
A row with a null `parent_id` opens a thread; every other row answers one, pointing at the root through `parent_id` with `ON DELETE CASCADE`.
There is no third level, and nothing enforces one beyond the fact that no route accepts a parent that is itself a reply.

`answered_at` and `answered_by` are set only on root rows and are the whole state a thread has.
Nothing is edited and nothing is deleted: reopening writes null back, and both transitions append to the activity log under their own actions, so the record still says what happened.

The author is stored twice on purpose.
`author_id` references the account, and reads prefer the live account name so renaming yourself stays consistent across everything you ever said; `author_name` is the snapshot that keeps a removed author's messages readable.
`agent_token_id` names the credential that wrote a message, exactly as `audit_events` does, because a token is a delegation and the person stays the author.

Open-thread counts reach the board through one grouped query per project rather than one per page, and a single page read counts for itself instead of reporting zero.
The count is on `Page` rather than in the Markdown, which is why `publicPage` takes the project it belongs to.

Who a message named lives in `discussion_mentions`, one row per message per person, written once when the message is written.
Names are matched against the project's members rather than parsed as a token, longest name first, because a name has spaces in it and no pattern decides on its own where `@Maren Voss said` stops being a name.
The `@` has to start a word and the name has to end on one, so an address is not a mention and `@Alanis` is not `@Alan`.
Storing ids rather than re-reading the text on every load is what keeps a mention pointing at the same person after a rename, and is what a relay to another system would need: a name means nothing to Discord and an account id can be mapped to one.

How much of a conversation somebody has not read lives in `discussion_seen`, one row per person per page, holding the moment they last opened it.
A page with no row has never been opened by that person, so everything on it is unread; their own messages never count.
It is a timestamp rather than a sequence because it is scoped to one page rather than to the whole project's log, and a message already carries the moment it was written.
The counts reach the board through one grouped query per project, the same way the open-thread counts do, and the marker is written only when the second column is actually turned to the conversation - an agent cannot write one at all, because it has no attention to spend.


## Search

`GET /api/search` answers for one whole project rather than for one workspace.

The board can only render four columns, so a match in the backlog, in the idea garden, or in a page that was archived has nowhere to appear in it.
The endpoint reads the same canonical Markdown the board and garden read, matches titles and note bodies, and returns each hit with the group it belongs to and the column, idea state, or archival month a reader would name it by.
Ranking prefers a title that starts with the query, then a title that contains it, then a mention in the notes, and groups arrive in reading order so the interface never sorts them again.
Snippets are reduced to plain text, so Markdown syntax and Obsidian embeds never reach a result row.

Archived ideas are excluded on purpose.
Promotion archives an idea and creates a page with the same title, so including them would return every promotion twice.

Search is the only interface route into the archive after the eight-second undo has passed, so it also carries the way out.
An archived result restores through the same `POST /api/pages/{id}/restore` the undo uses, with the same dependency validation, and is then opened rather than merely announced.

## Live collaboration

Authenticated browsers keep one Server-Sent Events connection open at `/api/events`.
Each connection is scoped to the signed-in user's project, and the server never sends project events across membership boundaries.
Mutation requests carry a browser-specific client ID so the server can exclude the writer from its own broadcast.
The writer already reloads canonical state after its mutation succeeds.

Events identify Work, Ideas, or both as affected rather than carrying partial page data.
Receiving browsers coalesce nearby events and reload the affected workspace from Markdown.
This invalidation model keeps one source of truth and avoids merging stale client-side patches when several people edit close together.
The event stream sends periodic keepalive comments and is closed before the database during graceful server shutdown.

The same stream carries presence.
Who is online is derived from the set of open streams rather than stored, so a browser that closes, crashes, or loses its connection stops counting as present without a heartbeat table or an expiry sweep.
Opening or closing a stream sends the project's current list of online user identifiers to everyone in that project.
Several streams belonging to one person count once.

## Link previews

A page or idea link pasted into a chat client is fetched by that client, not by the person who received it, and always without a session.
Grimoire answers those requests by rewriting the title and description of the application shell between the `link-preview` markers in `index.html`, so the served document names the page rather than the product.
Everything else in the shell, including the client bundle and the `noindex` directive, is untouched.

The preview carries the title, board name, column, category, assignee, and blocked state, and never the Markdown notes body.
That set is a deliberate boundary: holding the link is enough to read it, so the preview says only what a teammate needs to recognize the page.
Ids are unique across projects, so a link carries only the id and the lookup walks the live projects to place it.
An archived page and a promoted idea still describe themselves, and a link naming nothing that can be read falls back to the generic Grimoire preview rather than failing the page.

## Reversible actions

Page archive and idea promotion are server-backed reversible operations.
The interface offers their undo actions for eight seconds, but correctness does not depend on browser memory or an optimistic visual rollback.

Archiving records any dependency links it removes in the archived page's `unblocked_cards` metadata.
Restoring the page moves the same Markdown file back to the active directory, restores its prior position, reconnects those still-valid links, and validates the resulting dependency graph before writing.

Undoing an idea promotion removes its generated page and moves the archived idea back to its former state and rank.
Grimoire refuses this operation when the generated page has been edited or another page depends on it, which prevents undo from deleting subsequent work by a collaborator.

One Grimoire server process should own a project directory at a time.

## Concurrent edits

Page and idea content is written with a per-field compare and swap rather than last writer wins.

A client that rewrites `title` or `description` sends that field together with the value it was working from, as `expectedTitle` or `expectedDescription`.
The server compares the expectation against what is stored and refuses the write with `409` when they differ, returning `conflict: true`, the field, and the stored record so the editor can show the collision without a second request.
The check is per field and opt in per request, which keeps two independent facts true at once: renaming a page cannot collide with a teammate rewriting its notes, and a column move or reorder carries no text and therefore sends no expectation at all.

The interface holds the matching half of the contract.
An open editor sends only the fields the reader changed, so an untouched field is never transmitted and can never overwrite anything.
A field the reader has not touched adopts incoming content from the live update instead of holding a stale copy, and names the actor from the activity log rather than adding an author field to the Markdown.
While a refusal is unresolved the editor writes nothing at all and will not close, so the choice between the two versions is always made by a person.

This is also what protects edits made outside Grimoire.
A body rewritten directly in the Markdown file survives a rename made in the browser, because the rename never carries a description, and a browser rewriting the same body is refused against the external text.

## Signing in

There is one session, and everything that creates one creates the same one: an opaque token, stored only as a sha256 hash, in the same cookie with the same age.
A provider sign-in ends at the same `setSession` a password sign-in ends at, so nothing downstream — membership, authorship, presence, the activity log — knows or needs to know which door somebody came through.

Single sign-on is authorization code with PKCE against the provider's discovery document, written on Node's own crypto rather than a client library.
That is a deliberate cost. It keeps the dependency list short enough to read and the image a single small container, which is most of the argument for self-hosting Grimoire at all.

The identity token is verified against the provider's published keys even though it arrives over TLS from the provider itself: the signature is what makes the claims evidence rather than something a misrouted or relayed response could put in front of us.
Issuer, audience, expiry, and a nonce that ties the token to the browser that began the flow are all checked, and an unknown key id earns exactly one refetch of the key set, because that is what a rotation looks like.
The state travels twice — in the redirect and in a short-lived cookie scoped to the callback route — so a callback completed in somebody else's browser cannot be handed to a colleague to quietly sign them into the wrong account.
The verifier, nonce and pending state are held in memory, because a flow that outlives a restart is a flow nobody is still waiting on, and persisting it would mean writing a secret to disk to save somebody a click.

The provider is configured from a screen, and the settings live in a single row of `oidc_settings` rather than only in the environment.
That is a deliberate reversal of where this kind of configuration usually goes, and the reason is that the environment is a bad place to iterate: getting a provider working takes two or three attempts even when everything is right, and each of those attempts should not be a redeploy.
The environment still wins wherever it says anything, so a deployment that describes itself in a file keeps doing that and the screen goes read-only rather than pretending to be live — two places that can disagree about what is in force is worse than either place alone.
The provider is therefore resolved per request rather than held from boot, and one built provider is cached against the configuration that produced it so the discovery document and signing keys are not refetched on every sign-in.

The screen is shaped by how these setups actually fail. They fail on a redirect address that does not match to the character, so it is shown, exactly, ready to copy, rather than described. They fail on a handful of endpoint URLs somebody transcribes, so those are read from the provider instead of asked for. And they fail silently, hours later, when somebody first tries to sign in — so the same call that fills the screen in also reports what it found, and says plainly that it has not checked the client id and secret, because nothing short of a real sign-in does.

Three spellings of an issuer are accepted, because providers hand people all three and call them the same thing: with a trailing slash, without, and as the full discovery URL. The last one carries a real consequence. The specification's anti-spoofing rule is that a document fetched from the well-known path under an issuer must name that issuer, and it is enforced — but only when the issuer is what built the URL. An operator who pasted a discovery URL outright has already chosen the document, and holding them to that check would refuse every provider that does not sit at the standard path.

An account is matched by email, which is what makes turning single sign-on on a non-event for an installation that already has people in it.
That match is then recorded in `oidc_identities`, against the issuer the verified token asserts and the subject id it carries, and it is what answers the question on every sign-in afterwards.
Email and subject are doing two different jobs and it matters that different values do them: an address is what somebody already recognises about a colleague, which is what lets the first provider sign-in land on the account they already had, and it is also a thing people change — which is exactly what a durable identity must not be.
An installation that re-derived the link from email every time would hand somebody a second, empty account on the day they changed their address, and lose everything they had done.
So the provider is treated as the authority on its own people's addresses and the Grimoire account follows, with two refusals rather than guesses: an address another account already answers to is a merge, and which history survives a merge is a person's decision; and a different subject presenting a linked account's address is refused because either guess signs somebody in as somebody else.
The issuer is stored beside the subject because a subject id means nothing except under the provider that minted it, so swapping providers leaves old links inert rather than letting a colliding id inherit an account.
A link is a claim about which account somebody is and never a reason to admit them: membership is still checked afterwards, so removing somebody from every project stops their provider sign-in exactly as it stops their password sign-in.
Creating one is the case that needed a decision. Grimoire is invitation-only, and a provider vouching for somebody is not by itself a reason to put them on a board — but a team that has just pointed Grimoire at their own identity provider has already said who is allowed in, and making each of them also follow an invitation link asks that question twice. So auto-registration is on by default, and the guard that makes it safe is an allowed-domain list: without one the default means anybody your provider vouches for, which is your team when the provider is yours and the entire internet when it is Google's. An invitation still creates an account whatever that setting says.
The account gets a password hash of something unguessable rather than a marker, so a sign-in attempt against it costs exactly what every other attempt costs and cannot be told apart by timing.
The first-run account is always made with a password and never through a provider, because it is the account that can never be locked out, and a provider that has gone down should not be able to take an installation with it.

Failed password attempts are metered with token buckets, in memory, for the same reason agent writes are: the thing being prevented is a run of guesses against a process that is up.
Two buckets, sized differently on purpose. The source address is the tight one and is the actual wall; the account is the loose one, because it is the bucket an attacker can aim, and a lockout cheap enough to trip is a way to keep somebody out of their own board.
Only failures spend, so a right answer is never refused for having followed wrong ones.
Unlike an agent credential, the key here is chosen by whoever is knocking, so the map is swept: a bucket that has fully refilled is indistinguishable from one that never existed, and those are the ones that go.
Whether a forwarded address is believed is a deployment fact rather than a preference, so it is configured rather than guessed — wrong in one direction every visitor shares one allowance, wrong in the other the limit is free to step around.

## Agent access

Grimoire already had the API an agent needs, and lacked only a way for something without a browser to say who it is.
`agent_tokens` is that credential, and it mirrors `sessions`: an opaque secret, stored only as a sha256 hash, with the same primitives generating and comparing it.

A credential is a delegation rather than a second kind of account.
It names a project and a person, and requests made with it act as that person, which is why nothing about members, assignment, presence, or authorship needed a second code path.
Membership is rechecked on every request rather than trusted from issue time, so removing someone also stops the agents acting on their behalf.
Archiving a project suspends its credentials the same way, because archiving refuses every browser and takes the owner-facing revoke routes with it - a credential that stayed alive there would be one no human could ever stop again.
An expired or revoked credential resolves to nothing at all rather than to a lesser identity, so it can never quietly degrade into read access.

A browser session is consulted before any bearer header, so a signed-in person holding a token stays a person and their own work is never recorded as an agent's.

Requests made with a credential are pinned to its project.
`requireProject` otherwise falls back to the caller's default project, which is a convenience for a browser and a cross-project leak for an agent, so a credential never reaches that fallback and a mismatched `X-Grimoire-Project` is refused rather than redirected.

What a credential may reach is an allow list rather than a set of refusals spread through the routes.
Creating and editing pages and ideas is open, along with reading one page by id, and everything that destroys or restructures is closed: archiving, restoring, promoting an idea, the chapter, category and field definitions, invitations, membership and roles, the project itself, and every account route.
Chapter and category *membership* is a property of a page, as are its field values, so an agent editing a page may place it into an existing chapter or category, take it out again, and fill in any field the project defined - what it cannot do is create, rename, recolor, open, close, or delete any of those definitions.
Stated as a rule, an agent adds and refines and only a person destroys or restructures.
Archiving is the sharpest of those, because its undo lasts eight seconds and is built for a person who has just clicked, and search-restore recovers one page at a time.
Account routes are closed so a delegated credential cannot escalate into the identity it borrows, and the event stream is closed because presence is derived from open streams and an agent holding one would appear to be a teammate sitting in the project.
A route added later is closed to agents until someone decides otherwise, which is the point of writing it as an allow list: forgetting to open a route is a bug report, and forgetting to close one would be a hole.

Writes are metered per credential with a token bucket, held in memory.
The bucket guards the running process against a loop rather than a determined attacker, and persisting it would mean a write on every request in order to limit writes.
Reads are not metered, because they cost one query and cannot run the disk away.

## Legacy migration

The SQLite `pages` table remains only as an input for one-way migration from earlier Grimoire versions.
At startup, Grimoire writes every legacy row to its canonical Markdown location.
Legacy rows are deleted only after every corresponding Markdown file exists and validates.
The migration is restart-safe when a process stops after writing files but before clearing the old rows.

## Git ownership

Grimoire does not automatically commit or push project changes.
Point `GRIMOIRE_CARDS_DIRECTORY` into a Git repository when normal Git history, review, and backup behavior is desired.
Repository access should match the sensitivity of the project notes because work and idea Markdown contain plain project content.
