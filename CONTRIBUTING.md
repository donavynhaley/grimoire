# Contributing to Grimoire

Thank you for wanting to work on Grimoire. This document is the practical half of
contributing: how to get a development copy running, how the work is verified, and
what kinds of change are likely to land. The other half is the project's canon in
`docs/` — read the document that covers your change before writing it, because
pull requests are reviewed against those documents by name:

- [`docs/architecture.md`](docs/architecture.md) — every design decision that cost
  something, with its reason. Changing a documented decision means changing that
  document in the same pull request (DOC-3).
- [`docs/coding-standards.md`](docs/coding-standards.md) — the standards, each with
  a citable ID (`SRV-8`, `UI-1`). New code is held to every one of them.
- [`docs/ui-standards.md`](docs/ui-standards.md) — how interface work is built:
  motion ("nothing pops in"), dialogs, accessibility, the data contract, CSS. Read
  it before touching anything under `src/`.

## Getting set up

Node.js 24 or newer is required.

```sh
npm install
npm run dev
```

The Vite development interface serves at `http://127.0.0.1:5173` and the
collaborative API at `http://127.0.0.1:8080`. Configuration lives in
[`.env.example`](.env.example), and every option is documented there rather than
here so the two can never disagree. The SQLite database and Markdown project files
land under `data/`, which Git ignores.

Formatting and linting are Biome's, and the type checker runs strict:

```sh
npm run check     # tsc --noEmit && biome ci
npm run format    # rewrite instead of complain
```

## The three test suites

Grimoire is verified by three suites, and they answer different questions.

**Unit and integration tests** (`npm test`) run under Vitest and cover the server
and interface together — authentication, persistence, migration, live events,
concurrent editing, agent access, and the rest of the long list in the README's
Verification section. Most changes should arrive with a test here, and a bug fix
should arrive with the test that would have caught it.

**End-to-end tests** (`npm run test:e2e`) hold the app against a real Chromium as
both an emulated Pixel and a desktop: touch drags, tap-based moves, sheet
gestures, and the desktop presentation those must not disturb. Run
`npx playwright install chromium` once first. This suite runs on your machine
rather than in CI, so run it yourself before opening interface work.

**The MCP contract** (`npm run verify:mcp`) builds `packages/grimoire-mcp` and
exercises it end to end against a real Grimoire server it spawns itself. Run it
whenever you touch the MCP package or the HTTP API it is a client of.

Continuous integration runs Biome, the unit suite, the production build, the MCP
verification, and the production container build on every pull request.

## What is welcome

- Bug fixes, especially ones that arrive with the failing test.
- Accessibility work: keyboard reach, focus, reduced motion, contrast.
- Self-hosting friction — anything that makes the Docker, proxy, or single
  sign-on path clearer or safer.
- Documentation that corrects something wrong or explains something the docs
  assume.
- Small features composed from the primitives that already exist, in the spirit
  of the decisions in `docs/architecture.md`.

If a change is large, or reverses a decision the docs defend, open an issue and
ask before building it. That conversation is cheap; a finished pull request in
the wrong direction is not.

## What is out of scope

Grimoire says no to some things on purpose, and the README defends each of these
at more length:

- Notifications, emails, and push messages. Grimoire waits until you visit.
- Story points as workflow, forecasting, burndown charts, or built-in pillars and
  milestones. An estimate is a number someone wrote down.
- Roles beyond owner and admin, or per-field permission matrices.
- Agent powers that let an agent destroy, restructure, or approve its own work.
  An agent adds and refines; only a person destroys or restructures, and only a
  person marks a thread answered.
- Telemetry or analytics of any kind.
- New dependencies without a reason the standards would accept. The dependency
  list is short because each entry was argued for.

## Pull requests

Keep a pull request to one idea. Write the commit the way the log already reads —
`fix(board): open a project without taking the board off the screen` — and when a
change closes a finding against the standards, name the ID it closes. Update the
canon in the same pull request as the code that changes it.

Your first pull request will be asked to sign the
[contributor license agreement](docs/contributor-license-agreement.md). It is a
licence rather than an assignment — you keep the copyright in what you write —
and signing is a single comment on the pull request; the CLA assistant asks for
it and remembers the answer.

Security problems should not arrive as pull requests or public issues. See
[SECURITY.md](SECURITY.md) for how to report one privately.
