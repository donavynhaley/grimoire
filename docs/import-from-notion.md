# Import a Notion board into Grimoire

Grimoire imports a Notion board from an **import map**: one JSON file in which you have
already decided where every task lands. Notion's own export is a zip of CSVs and Markdown
whose columns mean whatever your workspace decided they mean — a status named anything, a
priority that is really a severity, sprints encoded three different ways — so unlike the
[Trello](import-from-trello.md) and [Focalboard](import-from-focalboard.md) importers,
there is no export file Grimoire could read without guessing. Writing the map is the
migration's real work, the deciding, and the map is that work's committed record.

Nothing is written until a plan shows you exactly what would land where and you say go,
and running an import twice never duplicates a page.

## The map

```json
{
  "backlog_pages": [
    {
      "notion_task_id": 1042,
      "title": "Ward every entrance against scrying",
      "category": "Story",
      "column": "Backlog",
      "estimate": 8,
      "severity": "high",
      "note": "Merged with 1043 during reconciliation",
      "absorbs": [1043]
    }
  ],
  "as_is_pages": [
    {
      "notion_task_id": 1181,
      "title": "Put together a window display",
      "category": "Story",
      "column": "In progress",
      "estimate": 3
    }
  ],
  "done_pages": [
    {
      "notion_task_id": 970,
      "title": "Apprentice drills - measured casting time",
      "category": "Story",
      "column": "Done",
      "chapter": "sprint-2-stocking-the-shelves",
      "estimate": 5,
      "completed_at": "2026-07-29T03:17:49Z",
      "body": "The story itself, kept as the page's notes.",
      "source": "Sprint 1-6 history, Notion export"
    }
  ]
}
```

The three sections differ only in where their pages land:

- **`backlog_pages`** go to the Backlog with no chapter. Backlog means accepted but
  unscheduled, and a chapter is a sprint, so scheduling them would say something untrue.
- **`as_is_pages`** keep the column Notion had them in and join the chapter named by
  `--chapter` — the sprint in motion.
- **`done_pages`** land in Done under the sprint that delivered them, each row naming its
  own `chapter`, because history spans many.

Each row spends a few keys on the page itself: `notion_task_id` (the re-run guard),
`title`, `category`, `column`, and optionally `estimate`, `chapter`, `completed_at`,
`body`, `note`, `absorbs`, and `source`. **Every other key names one of your project's own
fields** — a `severity`, an `epics`, whatever you have defined in Project settings — and
must resolve exactly against a definition that already exists. A value the project has no
option for is an error, never a silent drop, because everything in a map was assigned
during reconciliation rather than inherited, so a miss is a mistake.

Column names take the board's own labels (plus the older "Waiting for Review"): Backlog,
Up Next, In progress, Review, Done. `estimate` is Grimoire's own field rather than a
custom one — a whole number, the one a chapter sums when it closes; a blank cell means no
estimate rather than zero. Notion records no completion time, so a done row may carry
`completed_at` as an explicitly-stated proxy; without one the import time is used, which
orders every page identically and is worse.

## Before you run it

Provision the project first, in the app: create it, add the categories and fields the map
resolves against, and — for a history import — turn on chapters and estimates and create
the chapters the map names. The importer reads definitions; it never creates them.

## Running it

The importer needs shell access to the machine running Grimoire and a moment when you can
stop the server. Dry-run first — this validates every row and prints the plan without
writing anything:

```sh
node ops/import-notion.mjs ./import-map.json ./data/cards ./data/grimoire.sqlite \
  --project my-project --as you@example.com --chapter current-sprint
```

`./data/cards` is your `GRIMOIRE_PAGES_DIRECTORY` and `grimoire.sqlite` sits beside it —
adjust both to wherever your deployment mounts them.

When the plan looks right, stop the server, take a backup, and apply:

```sh
docker compose stop   # or however you run Grimoire
tar -czf ../grimoire-before-import.tar.gz data
node ops/import-notion.mjs ./import-map.json ./data/cards ./data/grimoire.sqlite \
  --project my-project --as you@example.com --chapter current-sprint --apply
docker compose start
```

The backup is taken while the server is down because a copy of a live SQLite file is not a
restore point; [docs/deployment.md](deployment.md#backups) covers backups in general. The
published image carries no `ops/`, so a host without Node of its own runs the script from a
Node image with the checkout and the data directory mounted — and with
`--user "$(id -u):$(id -g)"`, so the files it writes are owned like the ones already there,
which is the difference between a board the server can edit afterwards and one it cannot.

The import is all-or-nothing: if any row fails validation, nothing is written and every
problem is listed. Fix the map (or provision what it names), then rerun. Rerunning after a
successful import is safe too — every imported page opens with `Imported from Notion task
<id>`, and a task already on the board is skipped, never duplicated.

## After the import

Start the server and load the board — every imported page is there, in position, after
whatever the board already held. Assignment stays a decision a person makes after the
move, and if the map carried history into closed sprints, close those chapters so each one
reports what it delivered.
