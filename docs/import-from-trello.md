# Import a Trello board into Grimoire

Grimoire imports a Trello board from the file Trello itself gives you — no map to write,
no third-party exporter, no API key. One command reads the export, shows you exactly what
it would create, and writes nothing until you say so.

## What you need

- Your board's JSON export. In Trello, open the board menu → **Print, export, and share**
  → **Export as JSON**, and save the file. (JSON export is available on free workspaces.)
- A Grimoire project for the board to land in, and your account's email on that instance.
- Shell access to the machine running Grimoire, and a moment when you can stop the server.

## Run it

Dry-run first. This validates every card and prints the plan without writing anything:

```sh
node ops/import-trello.mjs ./my-board.json ./data/cards ./data/grimoire.sqlite \
  --project my-project --as you@example.com
```

`./data/cards` is your `GRIMOIRE_PAGES_DIRECTORY` and `grimoire.sqlite` sits beside it —
adjust both to wherever your deployment mounts them.

When the plan looks right, stop the server and apply:

```sh
docker compose stop   # or however you run Grimoire
node ops/import-trello.mjs ./my-board.json ./data/cards ./data/grimoire.sqlite \
  --project my-project --as you@example.com --apply
docker compose start
```

The import is all-or-nothing: if any card fails validation, nothing is written and every
problem is listed. Fix the flags (or the export) and rerun. Rerunning after a successful
import is safe too — every imported page remembers its Trello card id, and cards already
on the board are skipped, never duplicated.

## How your board maps

**Lists become columns.** Common list names map themselves: *To Do* lands in Up Next,
*Doing* in In progress, *Icebox* in Backlog, *Done* in Done — emoji and punctuation
ignored. A list the importer does not recognise is reported as an error naming the fix:

```sh
--list "Waiting on client=Review" --list "Someday=Backlog"
```

One flag per list, and an explicit flag always beats the built-in table. Only lists that
still hold cards need mapping; empty leftovers are ignored.

**Cards become pages.** The description is already Markdown and is kept verbatim.
Checklists follow it as task lists — headings, order, and ticks preserved.

**Labels become the category, when they match.** A label named the same as one of your
project's categories (a `Bug` label, a `Bug` category) sets the page's category. Every
label, matched or not, is kept in a provenance footer at the end of the page.

**Nothing is silently lost.** Members on a card, the due date, and the card's labels are
written into the footer. Members are never turned into assignees — the export carries
Trello usernames, not the emails Grimoire knows your teammates by — so assignment stays
a decision a person makes after the move.

**History keeps its shape.** Each page's creation time is decoded from the Trello card id
(Trello ids embed it), its update time is the card's last activity, and a card landing in
Done carries that last activity as its completion time — so your Done column reads as
history, not as one undifferentiated import day.

**Trello's archive stays behind.** Archived cards and archived lists are skipped and
reported. If you want them, unarchive them in Trello before exporting.

## After the import

Start the server and load the board — every imported page is there, in position, after
whatever the board already held. Two things are worth a pass by hand: assignees (see
above), and estimates, which Trello does not have and Grimoire's chapters can sum.
