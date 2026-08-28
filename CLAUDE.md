# Working rules

Grimoire's conventions are written down in `docs/`, and they are canon — read the
one that covers the work before writing:

- **`docs/architecture.md`** — every design decision that cost something, with its
  reason. Changing a documented decision means changing this document in the same
  PR (DOC-3).
- **`docs/coding-standards.md`** — the standards, each with a citable ID
  (`SRV-8`, `UI-1`). New code is held to every one of them; a commit or PR that
  closes a finding names the ID it closes.
- **`docs/ui-standards.md`** — how interface work is built: motion ("nothing pops
  in"), dialogs, accessibility, the data contract, CSS. Read it before touching
  anything under `src/`.

`docs/code-audit-2026-08.md` is the record of how the codebase was measured against
the standards and what the cleanup then closed — history, not law, but the place to
look before re-arguing a decision it already settled.
