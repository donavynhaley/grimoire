# Grimoire architecture

Grimoire is a collaborative visual editor for a directory of Markdown cards.
The card files are the canonical project record, not an export or cache of database rows.

## Storage boundary

SQLite stores operational collaboration data:

- User accounts and password hashes.
- Browser sessions.
- Invitation records.
- Project identity and membership.

The configured card directory stores all card domain data:

- Title and board status.
- Ordering within a status.
- Assignment and authorship.
- Creation, update, and archival timestamps.
- The Markdown notes body.

This boundary keeps authentication private while allowing project work to remain readable, diffable, and portable.

## Directory layout

`GRIMOIRE_CARDS_DIRECTORY` selects the root directory.
Each project receives a directory based on its stable slug.
Active and archived cards are separated without changing their stable filenames.

```text
cards/
  wizard-simulator/
    cards/
      8b09c17f-8a5e-49f7-99a7-6f0dc7028b47.md
    archive/
      1a42ed21-1f61-4317-b987-d0487515c25a.md
```

Filenames use card UUIDs so changing a title does not create Git rename noise or break references.

## Card format

Every card contains strict scalar YAML frontmatter followed by its Markdown notes.

```md
---
id: 8b09c17f-8a5e-49f7-99a7-6f0dc7028b47
title: Create the potion workbench
status: in_progress
position: 2
assignee: owner@example.com
created_by: owner@example.com
created_at: "2026-08-03T14:20:00.000Z"
updated_at: "2026-08-03T16:45:00.000Z"
---

Build the first interactive version of the potion workbench.

## Acceptance notes

- Player can place ingredients.
- Failed combinations produce sludge.
- Results can be collected.
```

The supported status values are `backlog`, `ready`, `in_progress`, and `done`.
The `position` value is a zero-based integer within that status.
The `assignee` value is either a project member email or `null`.
The `created_by` value is the creator email.
Archived files also contain an `archived_at` timestamp.

Strings containing YAML punctuation are emitted as double-quoted JSON strings.
Unknown, duplicate, missing, or invalid frontmatter fields are rejected and logged with the exact file path rather than being silently discarded.

## Read and write behavior

Grimoire reads the card directory whenever it loads the board.
Edits made outside Grimoire therefore appear on the next board refresh.

Every individual file update is written to a temporary file, flushed, and atomically renamed over the prior version.
Archiving atomically moves the stable card file into the project archive before adding its archival timestamp.
Board moves may update several card positions, so those multi-file operations are deterministic but not a filesystem transaction.
If positions are duplicated after an interrupted external edit, Grimoire uses creation time and card ID as deterministic tie breakers.

One Grimoire server process should own a card directory at a time.
Optimistic revision checks should be added before supporting simultaneous edits from Grimoire and external editors as a normal workflow.

## Legacy migration

The SQLite `cards` table remains only as an input for one-way migration from earlier Grimoire versions.
At startup, Grimoire writes every legacy row to its canonical Markdown location.
Legacy rows are deleted only after every corresponding Markdown file exists and validates.
The migration is restart-safe when a process stops after writing files but before clearing the old rows.

## Git ownership

Grimoire does not automatically commit or push card changes.
Point `GRIMOIRE_CARDS_DIRECTORY` into a Git repository when normal Git history, review, and backup behavior is desired.
Repository access should match the sensitivity of the project notes because card Markdown contains plain project content.
