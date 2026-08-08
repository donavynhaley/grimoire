# Grimoire

Production: [grimoire.example.test](https://grimoire.example.test)

Grimoire is a small collaborative project space for the Wizard Simulator team.
It separates possible ideas from committed work while keeping both fast to capture and easy to understand.
The website is a visual editing layer over portable Markdown files.

The game project is represented entirely by work cards and ideas.
There are no built-in design pillars, milestones, outcomes, asset pipelines, sprints, or story-point systems.

## Work

Grimoire keeps the main board limited to the work that currently deserves the team's attention:

- **Up Next** contains the small set of cards that someone can pick up now.
- **In progress** shows what the team is actively working on.
- **Done** shows the eight most recently completed cards.

Accepted work outside the active deck lives in a searchable Backlog library instead of occupying a permanent board column.
The library can be filtered by category, assignee, or blocked state, and any card can move into Up Next with one action.
Moving a card into Up Next keeps the library open so several cards can be selected in one pass.
Cards can be dragged between active columns, reordered within a column, or dropped onto the Backlog control.
Neighbouring cards glide aside as the drop target moves rather than snapping, and the motion is suppressed when the system asks for reduced motion.
Press `B` while focus is on the board to open the Backlog library.

Clicking the Done heading opens the complete searchable history, grouped by completion month and filterable by category or assignee.
Completed cards are never automatically archived or deleted, and any completed card can be reopened into Up Next.
Moving a card into Done records its completion time, editing it preserves that time, and reopening it clears the completion time.

Every card can contain a title, optional notes, and one assignee.
Notes are written in Markdown and shown rendered, so headings, emphasis, links, lists, task checkboxes, quotes, and code display as formatting instead of syntax.
Clicking the rendered notes, or the `edit` action beside them, opens the plain-text editor, and leaving it returns to the rendered view.
Links in notes open in a new tab without disturbing the card.
Pasting or dropping a screenshot into the notes editor uploads it to the project's `images/` directory and embeds it with Obsidian's `![[name]]` syntax, including support for Obsidian's `![[name|300]]` display sizes.
Because the embed resolves by file name, images keep working when a card is archived, restored, or promoted from an idea, and they render natively if the project directory lives inside an Obsidian vault.
Board and library tiles reduce notes to plain text so Markdown syntax never clutters a preview.
Idea notes work the same way in both the idea dialog and the garden tiles.
Assignees are visible directly on the board so the current team focus is clear at a glance.
Each card can also have one game-development category: Design, Code, Modeling, Texturing, Animation, Narrative, Audio, UI, VFX, or Production.
Category color rails and compact labels make different disciplines visible without turning categories into another workflow.

Cards can be blocked by other cards.
The board shows a blocked marker while any linked blocker is not Done, and the marker resolves automatically when the blocking work is completed.
Dependency cycles, self-links, and archiving an unfinished blocker with active dependents are rejected.
Archiving a card offers an eight-second undo action.
Undo restores the card to its prior place and reconnects dependency links that the archive removed.

Status and assignee changes use direct buttons instead of dropdown menus.
On touch devices, the same compact status buttons provide an alternative to dragging.

The work capture reveals compact category, assignment, and column controls after typing begins.
Typing `#`, `@`, or `/` opens the matching picker without leaving the keyboard, and the command text is removed from the saved title.
After a configured capture, a temporary `same settings` action can restore its category, assignment, and column for another related card.

Columns stack into a single vertically scrolling page on tablet and phone widths, so the board never scrolls sideways.

The visible filter bar can focus the board on unassigned work or work assigned to any team member, including the signed-in person.
Search and people filters combine, and the current view is stored in the URL so a useful view can be bookmarked or shared.
Dragging remains available while filters are active, and visible drop targets map back to the full column order.
Press `1` for Work or `2` for Ideas globally or from an empty capture field.

## Ideas

The Idea garden keeps possibilities away from the work backlog until the team deliberately commits to one.
Every new idea lands in the Inbox and can move directly to the manually ranked Shortlist or to Parked.
Shortlisted ideas can be dragged into priority order without adding scores, votes, or ceremony.
Parked ideas remain searchable and recoverable without competing for attention.

Promoting an idea creates one Backlog card with the same title and Markdown notes.
The source idea is archived with a stable link to the created card, so the decision remains traceable without duplicating active content.
Promotion also offers an eight-second undo action that restores the source idea and removes the generated card.
If anyone edits or links work to the generated card, Grimoire protects that work and refuses the undo.
Ideas do not have assignees or work statuses because they are not work yet.

## Collaboration

The first person to open a new Grimoire installation creates the owner account.
The first-run form prefills `owner@example.com` as the owner email, while still allowing it to be edited before setup.
The owner can create single-use invitation links from the Team dialog.
Only the newest unused invitation remains valid, and invitation links expire after seven days.
The owner can also remove members from the Team dialog, which revokes their sessions and live connections and clears their card assignments without erasing their authorship history.

Accounts, sessions, invitations, project membership, and the activity log are stored in a local SQLite database.
Cards and ideas are stored as Markdown files with validated YAML frontmatter.
Passwords are protected with scrypt, and browser sessions use HttpOnly SameSite cookies.
After signing in, open the account menu from the top-right avatar to change your password or sign out.
Changing a password requires the current password and signs the account out on other devices.

Signed-in browsers receive project-scoped live updates whenever another browser changes work or ideas.
The browser that made a change applies its own response directly, while every other connected browser reloads the affected workspace from the canonical Markdown files.

Teammates with the project open are ringed in green on the people filter bar and in the Team dialog.
Presence is deliberately absent from the header, where it would mostly report the signed-in person back to themselves.
It follows the live connection itself, so it clears as soon as someone closes the tab or loses their network.

## Activity

The `activity` control in the header opens the project's history, newest first and grouped by day.
It records who created, edited, moved, archived, restored, and promoted every card and idea, along with project renames, category changes, invitations, joins, and removals.
Each entry names the fields that changed and what they changed from and to, and selecting a card entry opens that card.
Opening a card also shows its own recent history above the archive action.

Reordering a card inside a column, or reranking the shortlist, is not recorded, because a log shaped by dragging would bury the changes worth reading.
The history is kept in SQLite rather than the Markdown files and is never pruned.

## Local development

Node.js 24 or newer is required.

```sh
npm install
npm run dev
```

The Vite development interface is normally available at `http://127.0.0.1:5173`.
The collaborative API listens at `http://127.0.0.1:8080`.

Configuration options are documented in [.env.example](.env.example).
The SQLite database is stored in `data/grimoire.sqlite` by default and is ignored by Git.
Canonical project files are stored beneath `data/cards` by default.
Set `GRIMOIRE_CARDS_DIRECTORY` to a directory inside the Wizard Simulator repository if the work and ideas should share its Git history.

See [docs/architecture.md](docs/architecture.md) for the storage boundary, card format, migration behavior, and editing guarantees.
See [docs/deployment.md](docs/deployment.md) for the isolated Proxmox VM, Cloudflare Tunnel, automatic deployment, and backup procedure.

## Verification

```sh
npm test
npm run build
```

The test suite covers authentication, secure password changes, single-use invitations, member removal, Markdown persistence, legacy migration, external edits, live project events, presence, the activity log, the active deck, Backlog search, completion history, reversible archives and promotions, categories, card dependencies, assignments, filtering, idea ranking, ordering, drag-and-drop interaction, Markdown note rendering, and pasted note images.

## Self-hosting

```sh
docker compose up -d --build
```

The Compose configuration exposes Grimoire on port `8080` and persists both SQLite identity data and Markdown cards in the local `data` directory.
Place Grimoire behind a TLS-enabled reverse proxy before inviting collaborators over the internet.
Production session cookies are marked Secure and require HTTPS.

Back up the `data` directory to preserve accounts, work, and ideas.
Do not run multiple Grimoire containers against the same SQLite file or project directory.
