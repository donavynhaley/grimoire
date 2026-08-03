# Grimoire

Grimoire is a collaborative game-development workspace for turning loose ideas into focused, playable outcomes.
It is being designed around the real production workflow of Wizard Simulator and its small team of programmers, writers, artists, and designers.

The project exists to make four things easy:

- Capture an idea without accidentally committing the team to building it.
- Give the whole team a clear view of the game's current direction.
- Show each person what they can work on right now.
- Preserve the connection between creative intent, production work, assets, builds, and playtest decisions.

Grimoire is not intended to be a generic enterprise project manager.
It does not organize work around sprints, story points, or fictional completion percentages.
It follows the iterative loop of making a game:

```text
idea -> experiment -> playable outcome -> production -> integration -> playtest -> decision
```

## Product principles

### Direction before activity

Every active piece of work should connect to a current game direction, design pillar, or playable milestone.
The team should be able to explain why something is being built before tracking how it is being built.

### Capture is not commitment

Ideas belong in an inbox until the team deliberately promotes them into an experiment or outcome.
Saving an exciting thought should reduce scope pressure rather than create it.

### Progress must be playable

An asset in a folder or an isolated system in code is not meaningful progress by itself.
Grimoire tracks when work becomes integrated, playable, and validated through observation.

### Handoffs are first-class work

Game production crosses disciplines constantly.
Models move to texturing, writing moves to implementation, code moves to integration, and everything eventually moves to playtesting.
Grimoire makes ownership, dependencies, artifacts, and handoff notes visible.

### The tool should stay quiet

Grimoire should reduce coordination overhead rather than becoming another place that demands maintenance.
The interface favors compact information, deliberate status changes, and a small number of opinionated workflows.

## Core concepts

- **Direction** describes the part of the player experience the team is currently trying to improve.
- **Idea** records a possibility without adding it to the production plan.
- **Experiment** asks a design question and defines the smallest useful way to test it.
- **Outcome** describes something meaningfully playable, observable, or reviewable.
- **Work** is a concrete responsibility owned by one person and linked to an outcome.
- **Asset** carries source files, technical requirements, production stages, and handoffs.
- **Playtest** records observations, evidence, feedback, and resulting decisions.
- **Build** is a snapshot of what became playable at a meaningful point in development.

The domain model is described in more detail in [docs/product-foundation.md](docs/product-foundation.md).

## Initial experience

The first screen is a project overview that answers:

1. What are we trying to make playable next?
2. What is everyone currently working on?
3. What is blocked or waiting for review?
4. Which assets are moving between disciplines?
5. What ideas have been captured for later?

The initial prototype includes a working local idea-capture interaction and representative Wizard Simulator data.
It does not yet persist data or provide authentication.

## Development

Grimoire currently uses React, TypeScript, and Vite for its initial interface prototype.
The collaborative server, persistent data model, authentication, and deployment architecture will be introduced after the core workflows have been tested against real Wizard Simulator work.

Install dependencies and start the development server:

```sh
npm install
npm run dev
```

Verify the TypeScript project and create a production build:

```sh
npm run build
```

## Current status

Grimoire is at the product-foundation and interface-prototype stage.
The current work is focused on validating the project overview, idea capture, individual work view, and cross-discipline asset handoffs before implementing the collaborative backend.
