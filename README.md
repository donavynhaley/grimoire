# Grimoire

Grimoire is a focused, collaborative game-development workspace for turning loose ideas into playable outcomes.
It is built around the real production workflow of Wizard Simulator and its small team of programmers, writers, artists, and designers.

Grimoire keeps a team aligned without imposing sprints, story points, or fictional completion percentages.
Its workflow follows the way an iterative game actually moves:

```text
idea -> experiment -> playable outcome -> production -> integration -> playtest -> decision
```

## What Grimoire does

- Captures ideas without committing the team to build them.
- Keeps the current game direction, design pillars, and next playable milestone visible.
- Promotes promising ideas into outcomes with explicit definitions of done.
- Breaks outcomes into owned work across code, art, writing, design, audio, and integration.
- Tracks dependencies so blocked work becomes ready when its prerequisites are completed.
- Moves assets through discipline-specific stages such as modeling, texturing, integration, and review.
- Records builds, playtest observations, decisions, comments, and project activity.
- Gives each collaborator a focused view of the work they can act on now.

## Product principles

### Direction before activity

Every active piece of work should connect to a current game direction, design pillar, or playable milestone.
The team should be able to explain why something is being built before tracking how it is being built.

### Capture is not commitment

Ideas remain in an inbox until the team deliberately promotes them into an experiment or outcome.
Saving an exciting thought should reduce scope pressure instead of creating it.

### Progress must be playable

An asset in a folder or an isolated system in code is not meaningful progress by itself.
Grimoire tracks when work becomes integrated, playable, and validated through observation.

### Handoffs are first-class work

Game production crosses disciplines constantly.
Models move to texturing, writing moves to implementation, code moves to integration, and everything eventually moves to playtesting.
Grimoire keeps ownership, dependencies, artifacts, and handoff notes visible.

### The tool should stay quiet

Grimoire should reduce coordination overhead instead of becoming another place that demands maintenance.
The interface favors compact information, deliberate status changes, and a small number of opinionated workflows.

The full domain model and product rationale are documented in [docs/product-foundation.md](docs/product-foundation.md).

## Technology

Grimoire uses React 19, TypeScript, and Vite for the interface.
The collaborative server uses Node's built-in HTTP and SQLite support with Zod validation.
Passwords are protected with scrypt, and browser sessions use HttpOnly SameSite cookies.
The application has no external database or service dependency, which keeps self-hosting straightforward.

## Local development

Node.js 24 or newer is required.

```sh
npm install
npm run dev
```

The web interface is normally available at `http://127.0.0.1:5173`.
The API listens at `http://127.0.0.1:5175`, and Vite proxies browser requests to it.
If those ports are occupied, Vite selects the next available web port and prints it in the terminal.

On the first visit, Grimoire asks you to create the owner account and seeds a Wizard Simulator workspace.
The owner can then create one-use invitation links from the Team view.
Each invitation expires after seven days.

Configuration can be supplied through the environment variables shown in [.env.example](.env.example).
Grimoire stores its SQLite database in `data/grimoire.sqlite` by default.
The `data` directory is ignored by Git.

## Verification

```sh
npm test
npm run build
```

The test suite covers authentication, invitations, persistent workspaces, ideas, outcomes, dependency-aware work, asset handoffs, builds, playtests, and core browser interactions.
The production build includes a complete static frontend that is served by the collaborative Node server.

## Self-hosting with Docker

```sh
docker compose up -d --build
```

The Compose configuration exposes Grimoire on port `5175` and persists its database in the local `data` directory.
Place Grimoire behind a TLS-enabled reverse proxy before inviting collaborators over the internet.
Production session cookies are marked Secure and therefore require HTTPS in a browser.

Back up the `data` directory to preserve all accounts and project history.
Do not run multiple Grimoire containers against the same SQLite file.

## Project model

- **Direction** describes the part of the player experience the team is currently trying to improve.
- **Idea** records a possibility without adding it to the production plan.
- **Experiment** asks a design question and defines the smallest useful way to test it.
- **Outcome** describes something meaningfully playable, observable, or reviewable.
- **Work** is a concrete responsibility owned by one person and linked to an outcome.
- **Asset** carries source files, technical requirements, production stages, and handoffs.
- **Playtest** records observations, evidence, feedback, and resulting decisions.
- **Build** is a snapshot of what became playable at a meaningful point in development.

## Current status

Grimoire is a working collaborative application ready for the Wizard Simulator team to use and refine through real production.
The project intentionally begins with one game and one opinionated workflow so future features are driven by observed needs rather than generic project-management conventions.
