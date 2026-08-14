# Grimoire architecture

Grimoire is a collaborative visual editor for a directory of Markdown work pages and ideas.
The Markdown files are the canonical project record, not an export or cache of database rows.

## Storage boundary

SQLite stores operational collaboration data:

- User accounts and password hashes.
- Browser sessions.
- Invitation records.
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

Because the log is written by the API, edits made directly to the Markdown files do not appear in it.
The log is append-only, is never pruned, and is scoped to one project on both read and write.
Reads page backwards through a monotonic sequence number rather than a timestamp, which keeps paging stable when several events share a millisecond.

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

## Legacy migration

The SQLite `pages` table remains only as an input for one-way migration from earlier Grimoire versions.
At startup, Grimoire writes every legacy row to its canonical Markdown location.
Legacy rows are deleted only after every corresponding Markdown file exists and validates.
The migration is restart-safe when a process stops after writing files but before clearing the old rows.

## Git ownership

Grimoire does not automatically commit or push project changes.
Point `GRIMOIRE_CARDS_DIRECTORY` into a Git repository when normal Git history, review, and backup behavior is desired.
Repository access should match the sensitivity of the project notes because work and idea Markdown contain plain project content.
