# Product foundation

## Purpose

Grimoire is the shared production workspace for Wizard Simulator.
It gives the team a durable place to preserve ideas, choose a direction, divide creative work, coordinate handoffs, review builds, and understand how the game is progressing.

The product is designed for a small team whose work crosses game design, writing, modeling, texturing, audio, programming, level integration, and playtesting.

## Development loop

An idea begins as an inexpensive note.
The team can connect it to the game's direction, leave it for later, reject it with a recorded reason, or promote it into an experiment.

An experiment asks a question about the player experience.
When the answer justifies continued work, the experiment becomes a playable outcome.

An outcome is divided into owned work and linked assets.
Dependencies make the sequence of production visible without forcing every discipline into the same workflow.

Completed work is integrated into a build and observed through playtesting.
The resulting decision may validate the outcome, send it back for revision, create follow-up ideas, or cut it from the game.

## Initial information architecture

### Overview

The overview presents the current direction, milestone, team focus, blockers, handoffs, idea inbox, and recent playable progress.

### Direction

Direction contains the game pitch, player fantasy, design pillars, current focus, explicit non-goals, and current milestone success conditions.

### Outcomes

Outcomes organize experiments and playable results through shaping, active production, playtesting, integration, and validation.

### Ideas

Ideas provides fast capture followed by deliberate sorting into current work, later consideration, references, or rejected concepts.

### Assets

Assets tracks source files and discipline-specific production stages such as concept, model, UV, texture, export, engine import, integration, and review.

### Playtests

Playtests connects observations and evidence to the experiment, outcome, build, and decision they affected.

### My work

My Work shows one person's current responsibility, ready work, requested reviews, blockers, and recently completed contributions.

## Status models

Ideas use `inbox`, `considering`, `later`, `promoted`, and `rejected`.

Experiments use `shaping`, `ready`, `running`, `observed`, and `decided`.

Outcomes use `shaping`, `ready`, `active`, `playtest`, `integrated`, `validated`, `revise`, and `cut`.

Individual work uses `blocked`, `ready`, `doing`, `review`, and `done`.

Asset stages are defined by a reusable pipeline, with one owner and completion state per stage.

## Initial boundaries

Grimoire will not initially provide sprints, story points, velocity reports, Gantt charts, general-purpose workflow builders, built-in chat, or time tracking.

Discord remains the home for general conversation and the Wizard Simulator Timekeeper remains the source of truth for contributed hours.
Grimoire keeps discussion attached to the project object that needs it.

## First implementation sequence

1. Validate the overview and quick idea-capture experience with the real team.
2. Implement persistent projects, members, directions, ideas, and outcomes.
3. Add authentication and invite-only project access.
4. Add owned work, dependencies, review requests, and handoffs.
5. Add asset pipelines and artifact storage references.
6. Add experiments, builds, playtests, and decision history.
7. Deploy the application to the project server and use it for active Wizard Simulator production.

