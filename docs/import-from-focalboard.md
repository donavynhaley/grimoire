# Import a Focalboard board into Grimoire

Focalboard's development has ended, but its boards don't have to. Grimoire imports a
board straight from the `.boardarchive` file Focalboard exports — handed over unopened,
no unzipping, no map to write. One command reads the archive, shows you exactly what it
would create, and writes nothing until you say so.

Like Focalboard, Grimoire is self-hosted, open source, and keeps your work in files you
own — pages are plain Markdown on your own disk, readable with or without the app.

## What you need

- Your board's archive. In Focalboard, open the board menu → **Export board archive**,
  and save the `.boardarchive` file. An already-unzipped archive directory, or a single
  `board.jsonl` out of one, works too.
- A Grimoire project for the board to land in, and your account's email on that instance.
- Shell access to the machine running Grimoire, and a moment when you can stop the server.

## Run it

Dry-run first. This validates every card and prints the plan without writing anything:

```sh
node ops/import-focalboard.mjs ./my-board.boardarchive ./data/cards ./data/grimoire.sqlite \
  --project my-project --as you@example.com
```

`./data/cards` is your `GRIMOIRE_PAGES_DIRECTORY` and `grimoire.sqlite` sits beside it —
adjust both to wherever your deployment mounts them.

When the plan looks right, stop the server and apply:

```sh
docker compose stop   # or however you run Grimoire
node ops/import-focalboard.mjs ./my-board.boardarchive ./data/cards ./data/grimoire.sqlite \
  --project my-project --as you@example.com --apply
docker compose start
```

The import is all-or-nothing: if any card fails validation, nothing is written and every
problem is listed. Fix the flags (or the export) and rerun. Rerunning after a successful
import is safe too — every imported page remembers its Focalboard card id, and cards
already on the board are skipped, never duplicated.

An archive holding several boards imports one board per run — pick one with
`--board <id-or-title>`, and the importer lists what the archive holds if you don't.

## How your board maps

**Your status property becomes the columns.** Focalboard has no fixed columns — a kanban
view groups cards by whichever select property it is told to — so the importer finds the
status property the way your board did: the property its board view groups by, or a
select named *Status*, or the only select there is. If the board is too ambiguous to
read, `--status "Property Name"` settles it.

Common option values map themselves: *Not Started* lands in Backlog, *In Progress* in
In progress, *Completed* in Done — emoji and punctuation ignored. A value the importer
does not recognise is reported as an error naming the fix:

```sh
--option "Blocked=Review" --option "Someday Maybe=Backlog"
```

One flag per value, and an explicit flag always beats the built-in table. A card with no
status at all lands in Backlog — Focalboard showed it under "No status", and Backlog is
that group's honest translation.

**Card content becomes the page.** Text blocks stay Markdown, checkboxes keep their
ticks, dividers stay rules, all in the card's own order. Comments, images, and
attachments do not travel — the footer counts what was left behind, so a lossy copy at
least says what it lost.

**Every other property survives by name.** Selects resolve to their values, dates to
days, text and numbers verbatim, all written into a provenance footer at the end of the
page. Person properties are the exception — the export names people by opaque ids, so
assignment stays a decision a person makes after the move.

**History keeps its shape.** Pages carry the card's own created and updated times, and a
card landing in Done carries its last update as its completion time — so your Done
column reads as history, not as one undifferentiated import day.

**Templates stay behind.** Card templates are stationery, not work, and are skipped and
reported.

## After the import

Start the server and load the board — every imported page is there, in position, after
whatever the board already held. Two things are worth a pass by hand: assignees (see
above), and estimates, which Grimoire's chapters can sum when you're ready to plan.
