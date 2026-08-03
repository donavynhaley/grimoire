# Grimoire architecture

Grimoire is a collaborative visual editor for a directory of Markdown work cards and ideas.
The Markdown files are the canonical project record, not an export or cache of database rows.

## Storage boundary

SQLite stores operational collaboration data:

- User accounts and password hashes.
- Browser sessions.
- Invitation records.
- Project identity and membership.

The configured project directory stores all work card and idea domain data:

- Title and board status.
- Ordering within a status.
- Assignment and authorship.
- Creation, update, and archival timestamps.
- The Markdown notes body.
- Idea state and manual rank.
- The link from an archived idea to its promoted work card.

This boundary keeps authentication private while allowing project work to remain readable, diffable, and portable.

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
```

Filenames use record UUIDs so changing a title does not create Git rename noise or break references.

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
