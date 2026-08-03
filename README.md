# Grimoire

Grimoire is a small collaborative kanban board for the Wizard Simulator team.
It provides one fast place to capture ideas, choose what is ready, see who is working on what, and mark work complete.

The game project is represented entirely by cards.
There are no built-in design pillars, milestones, outcomes, asset pipelines, sprints, or story-point systems.

## The board

Grimoire has four columns:

- **Backlog** holds ideas and work that the team has not committed to yet.
- **Ready** contains cards that someone can pick up now.
- **In progress** shows what the team is actively working on.
- **Done** keeps recently completed work visible.

Cards can be dragged between columns and reordered within a column.
Every card can contain a title, optional notes, and one assignee.
Assignees are visible directly on the board so the current team focus is clear at a glance.

Status and assignee changes use direct buttons instead of dropdown menus.
On touch devices, the same compact status buttons provide an alternative to dragging.

## Collaboration

The first person to open a new Grimoire installation creates the owner account.
The first-run form prefills `owner@example.com` as the owner email, while still allowing it to be edited before setup.
The owner can create one-use invitation links from the Team dialog.
Invitation links expire after seven days.

Accounts, sessions, membership, and cards are stored in a local SQLite database.
Passwords are protected with scrypt, and browser sessions use HttpOnly SameSite cookies.
After signing in, open the account menu from the top-right avatar to change your password or sign out.
Changing a password requires the current password and signs the account out on other devices.

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

## Verification

```sh
npm test
npm run build
```

The test suite covers authentication, secure password changes, invitations, card persistence, assignments, editing, archiving, ordering, drag-and-drop interaction, and the card-only product boundary.

## Self-hosting

```sh
docker compose up -d --build
```

The Compose configuration exposes Grimoire on port `8080` and persists the database in the local `data` directory.
Place Grimoire behind a TLS-enabled reverse proxy before inviting collaborators over the internet.
Production session cookies are marked Secure and require HTTPS.

Back up the `data` directory to preserve accounts and cards.
Do not run multiple Grimoire containers against the same SQLite file.
