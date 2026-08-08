# Grimoire architecture

Grimoire is a collaborative visual editor for a directory of Markdown work cards and ideas.
The Markdown files are the canonical project record, not an export or cache of database rows.

## Storage boundary

SQLite stores operational collaboration data:

- User accounts and password hashes.
- Browser sessions.
- Invitation records.
- Project identity and membership.
- The append-only project activity log.
- Each member's private last-seen cursor into that log.

The configured project directory stores all work card and idea domain data:

- Title and board status.
- One optional game-development category.
- Links to cards that block other cards.
- Ordering within a status.
- Assignment and authorship.
- Creation, update, completion, and archival timestamps.
- The Markdown notes body.
- Idea state and manual rank.
- The link from an archived idea to its promoted work card.
- Temporary dependency restoration metadata for reversible card archives.

This boundary keeps authentication private while allowing project work to remain readable, diffable, and portable.

The activity log records who acted rather than what the work is, so it belongs with accounts and membership rather than with the cards.
Keeping it out of the Markdown also avoids adding a Git diff to every card move.
It is a deliberate consequence that a copied project directory carries the work but not its history.

The while-you-were-away digest is one row per member per project in `seen_cursors`: the newest `audit_events.sequence` that member has seen while their tab was visible.
Everything the returning reader is shown - the digest, the card and idea markers, the owner's badge and unread line - derives from the events after that cursor, with the reader's own actions excluded at the query.
Advances are MAX-guarded and clamped to the newest real sequence, so racing tabs, repeats, and stale requests can never rewind or overshoot the boundary, and a first look pins the cursor to the present so joining never dumps history as unread.

Only the newest unused invitation created by the owner remains valid, and a successful registration consumes it atomically.
Removing a member deletes their project membership, active sessions, live event streams, and seen cursor, and clears their assignments from the Markdown cards.
Their user identity remains in SQLite so cards they created continue to show accurate authorship history.

## Directory layout

`GRIMOIRE_CARDS_DIRECTORY` selects the root directory.
Each project receives a directory based on its stable slug.
Active and archived records are separated without changing their stable filenames.

```text
cards/
  wizard-simulator/
    cards/
      8b09c17f-8a5e-49f7-99a7-6f0dc7028b47.md
    archive/
      1a42ed21-1f61-4317-b987-d0487515c25a.md
    ideas/
      30981e89-3615-45bb-b25b-e544266502fa.md
      archive/
        4ed8f3c6-8e24-4386-8508-a28275c9f178.md
    images/
      pasted-image-20260807-183045-ab12.png
```

Filenames use record UUIDs so changing a title does not create Git rename noise or break references.

Images pasted into notes are stored once per project in `images/` and embedded with Obsidian's `![[name]]` syntax.
Embeds resolve by file name rather than by relative path, so a card keeps its images through archive and restore, and an idea keeps them through promotion.
The web application serves the same files through an authenticated project-scoped route, and a vault or repository that contains the project directory renders them natively in Obsidian.
Uploads are verified by content signature (PNG, JPEG, WebP, or GIF), written atomically with generated names, and never deleted by the application.

## Card format

Every card contains strict YAML frontmatter followed by its Markdown notes.

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
Done displays the eight newest completions while the history view reads every `done` card from the same canonical set.
The supported category values are `design`, `code`, `modeling`, `texturing`, `animation`, `narrative`, `audio`, `ui`, `vfx`, and `production`.
The `category` value can be `null`, and older files without the field are treated as uncategorized.
The `blocked_by` value is an inline array of card UUIDs, and older files without the field are treated as having no dependencies.
A card is blocked while at least one referenced card is not `done`.
Self-links, missing cards, duplicate links, and dependency cycles are rejected.
An unfinished card cannot be archived while unfinished work depends on it.
The `position` value is a zero-based integer within that status.
The `assignee` value is either a project member email or `null`.
The `created_by` value is the creator email.
The `completed_at` value is set when a card enters `done`, remains stable while that completed card is edited, and returns to `null` when the card is reopened.
Older `done` cards without `completed_at` use their last update time as a backward-compatible completion time.
Archived files also contain an `archived_at` timestamp.
When archiving removes dependency links from other cards, the archived file contains their UUIDs in `unblocked_cards` until restoration.

## Idea format

Idea files use the same strict frontmatter and Markdown body envelope as cards.

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
After promotion, the archived idea contains `promoted_to` with the created card UUID and `promoted_at` with the promotion timestamp.

Strings containing YAML punctuation are emitted as double-quoted JSON strings.
Frontmatter arrays use JSON-compatible inline YAML syntax and contain only strings.
Unknown, duplicate, missing, or invalid frontmatter fields are rejected and logged with the exact file path rather than being silently discarded.

## Read and write behavior

Grimoire reads the relevant Markdown directory whenever it loads Work or Ideas.
Edits made outside Grimoire therefore appear on the next refresh of that space.

Every individual file update is written to a temporary file, flushed, and atomically renamed over the prior version.
Archiving atomically moves the stable file into its archive before adding archival or promotion metadata.
Board moves and idea ranking may update several positions, so those multi-file operations are deterministic but not a filesystem transaction.
If positions are duplicated after an interrupted external edit, Grimoire uses creation time and record ID as deterministic tie breakers.

Idea promotion writes the new Backlog card before archiving the source idea.
The archived idea retains the created card UUID as a durable backlink.

## Activity log

Every change made through Grimoire appends one row to `audit_events`.
Each row records the actor, the entity type and identifier, a title snapshot, an action, and a list of readable field changes.

The recorded actions are `created`, `updated`, `moved`, `archived`, `restored`, `promoted`, `renamed`, `deleted`, `invited`, `joined`, and `removed`.
Cards, ideas, projects, categories, and team membership are all covered.
A column change is recorded as `moved` and any other edit as `updated`.

Reordering a card inside one column, or reranking the shortlist, produces no readable change and is deliberately not recorded.
Recording drags would bury real edits under a log shaped by pointer movement.

The actor name and entity title are snapshots taken at write time, so an archived or renamed card still reads correctly in the timeline.
Reads prefer the live account name when it is still available, so renaming an account stays consistent across that person's whole history.

Because the log is written by the API, edits made directly to the Markdown files do not appear in it.
The log is append-only, is never pruned, and is scoped to one project on both read and write.
Reads page backwards through a monotonic sequence number rather than a timestamp, which keeps paging stable when several events share a millisecond.

## Live collaboration

Authenticated browsers keep one Server-Sent Events connection open at `/api/events`.
Each connection is scoped to the signed-in user's project, and the server never sends project events across membership boundaries.
Mutation requests carry a browser-specific client ID so the server can exclude the writer from its own broadcast.
The writer already reloads canonical state after its mutation succeeds.

Events identify Work, Ideas, or both as affected rather than carrying partial card data.
Receiving browsers coalesce nearby events and reload the affected workspace from Markdown.
This invalidation model keeps one source of truth and avoids merging stale client-side patches when several people edit close together.
The event stream sends periodic keepalive comments and is closed before the database during graceful server shutdown.

The same stream carries presence.
Who is online is derived from the set of open streams rather than stored, so a browser that closes, crashes, or loses its connection stops counting as present without a heartbeat table or an expiry sweep.
Opening or closing a stream sends the project's current list of online user identifiers to everyone in that project.
Several streams belonging to one person count once.

## Reversible actions

Card archive and idea promotion are server-backed reversible operations.
The interface offers their undo actions for eight seconds, but correctness does not depend on browser memory or an optimistic visual rollback.

Archiving records any dependency links it removes in the archived card's `unblocked_cards` metadata.
Restoring the card moves the same Markdown file back to the active directory, restores its prior position, reconnects those still-valid links, and validates the resulting dependency graph before writing.

Undoing an idea promotion removes its generated card and moves the archived idea back to its former state and rank.
Grimoire refuses this operation when the generated card has been edited or another card depends on it, which prevents undo from deleting subsequent work by a collaborator.

One Grimoire server process should own a project directory at a time.
Optimistic revision checks should be added before supporting simultaneous edits from Grimoire and external editors as a normal workflow.

## Legacy migration

The SQLite `cards` table remains only as an input for one-way migration from earlier Grimoire versions.
At startup, Grimoire writes every legacy row to its canonical Markdown location.
Legacy rows are deleted only after every corresponding Markdown file exists and validates.
The migration is restart-safe when a process stops after writing files but before clearing the old rows.

## Git ownership

Grimoire does not automatically commit or push project changes.
Point `GRIMOIRE_CARDS_DIRECTORY` into a Git repository when normal Git history, review, and backup behavior is desired.
Repository access should match the sensitivity of the project notes because work and idea Markdown contain plain project content.
