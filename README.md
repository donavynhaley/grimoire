# Grimoire

Production: [grimoire.example.test](https://grimoire.example.test)

Grimoire is a small collaborative project space for the Wizard Simulator team.
It separates possible ideas from committed work while keeping both fast to capture and easy to understand.
The website is a visual editing layer over portable Markdown files.

The game project is represented entirely by work cards and ideas.
There are no built-in design pillars, milestones, outcomes, asset pipelines, sprints, or story-point systems.

## Work

Grimoire has four columns:

- **Backlog** holds work that the team has not committed to yet.
- **Ready** contains cards that someone can pick up now.
- **In progress** shows what the team is actively working on.
- **Done** keeps recently completed work visible.

Cards can be dragged between columns and reordered within a column.
Every card can contain a title, optional notes, and one assignee.
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
The owner can create one-use invitation links from the Team dialog.
Invitation links expire after seven days.

Accounts, sessions, invitations, and project membership are stored in a local SQLite database.
Cards and ideas are stored as Markdown files with validated YAML frontmatter.
Passwords are protected with scrypt, and browser sessions use HttpOnly SameSite cookies.
After signing in, open the account menu from the top-right avatar to change your password or sign out.
Changing a password requires the current password and signs the account out on other devices.

Signed-in browsers receive project-scoped live updates whenever another browser changes work or ideas.
The browser that made a change applies its own response directly, while every other connected browser reloads the affected workspace from the canonical Markdown files.

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

The test suite covers authentication, secure password changes, invitations, Markdown persistence, legacy migration, external edits, live project events, reversible archives and promotions, categories, card dependencies, assignments, filtering, idea ranking, ordering, and drag-and-drop interaction.

## Self-hosting

```sh
docker compose up -d --build
```

The Compose configuration exposes Grimoire on port `8080` and persists both SQLite identity data and Markdown cards in the local `data` directory.
Place Grimoire behind a TLS-enabled reverse proxy before inviting collaborators over the internet.
Production session cookies are marked Secure and require HTTPS.

Back up the `data` directory to preserve accounts, work, and ideas.
Do not run multiple Grimoire containers against the same SQLite file or project directory.
