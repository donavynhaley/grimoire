# Grimoire

Production: [grimoire.example.test](https://grimoire.example.test)

Grimoire is a small collaborative project space for the Wizard Simulator team.
It separates possible ideas from committed work while keeping both fast to capture and easy to understand.
The website is a visual editing layer over portable Markdown files.

The game project is represented entirely by work pages and ideas.
There are no built-in design pillars, milestones, outcomes, asset pipelines, or story-point systems.
A project can opt into Chapters, which group pages into named stretches of work, but nothing in them counts, estimates, or rolls over.

## Work

A unit of work is a **page**, and a project's pages are grouped into chapters when it uses them.
Pages were called cards until the vocabulary caught up with the rest of the product.
The older `/api/cards` routes still answer, so a browser still running a previous build keeps working, and each project's `cards/` directory is renamed to `pages/` the first time the newer version starts.

Grimoire keeps the main board limited to the work that currently deserves the team's attention:

- **Up Next** contains the small set of pages that someone can pick up now.
- **In progress** shows what the team is actively working on.
- **Done** shows the eight most recently completed pages.

Accepted work outside the active deck lives in a searchable Backlog library instead of occupying a permanent board column.
The library can be filtered by category, assignee, or blocked state, and any page can move into Up Next with one action.
Moving a page into Up Next keeps the library open so several pages can be selected in one pass.
Pages can be dragged between active columns, reordered within a column, or dropped onto the Backlog control.
Neighbouring pages glide aside as the drop target moves rather than snapping, and the motion is suppressed when the system asks for reduced motion.
Press `B` while focus is on the board to open the Backlog library.

Clicking the Done heading opens the complete searchable history, grouped by completion month and filterable by category or assignee.
Completed pages are never automatically archived or deleted, and any completed page can be reopened into Up Next.
Moving a page into Done records its completion time, editing it preserves that time, and reopening it clears the completion time.

Every page can contain a title, optional notes, and one assignee.
Notes are written in Markdown and shown rendered, so headings, emphasis, links, lists, task checkboxes, quotes, and code display as formatting instead of syntax.
Clicking the rendered notes, or the `edit` action beside them, opens the plain-text editor, and leaving it returns to the rendered view.
Links in notes open in a new tab without disturbing the page.
Pasting or dropping a screenshot into the notes uploads it to the project's `images/` directory and embeds it with Obsidian's `![[name]]` syntax, including support for Obsidian's `![[name|300]]` display sizes.
The whole notes field accepts drops whether it is being read or edited, highlights while a file is dragged across it, and the editor stays open while a screenshot is fetched from another window.
Because the embed resolves by file name, images keep working when a page is archived, restored, or promoted from an idea, and they render natively if the project directory lives inside an Obsidian vault.
Board and library tiles reduce notes to plain text so Markdown syntax never clutters a preview.
Idea notes work the same way in both the idea dialog and the garden tiles.
Assignees are visible directly on the board so the current team focus is clear at a glance.
Each page can also have one game-development category: Design, Code, Modeling, Texturing, Animation, Narrative, Audio, UI, VFX, or Production.
Category color rails and compact labels make different disciplines visible without turning categories into another workflow.

Pages can be blocked by other pages.
The board shows a blocked marker while any linked blocker is not Done, and the marker resolves automatically when the blocking work is completed.
Dependency cycles, self-links, and archiving an unfinished blocker with active dependents are rejected.
Archiving a page offers an eight-second undo action.
Undo restores the page to its prior place and reconnects dependency links that the archive removed.

Status and assignee changes use direct buttons instead of dropdown menus.
On touch devices, the same compact status buttons provide an alternative to dragging.

The work capture reveals compact category, assignment, and column controls after typing begins.
Typing `#`, `@`, or `/` opens the matching picker without leaving the keyboard, and the command text is removed from the saved title.
After a configured capture, a temporary `same settings` action can restore its category, assignment, and column for another related page.

Columns stack into a single vertically scrolling page on tablet and phone widths, so the board never scrolls sideways.

Press `/` anywhere to search the whole project at once.
The overlay covers every column, the backlog, the idea garden, completed work, and pages that were archived, and it reads note bodies as well as titles.
Results are grouped by where each one lives, so a match is a place to go rather than a bare row, and selecting one opens it in its home view.
Archived pages are listed with the text that matched.
They cannot be opened, because an archived page has no editable place to return to, so their row carries a `restore` action instead.
Restoring puts the page back in the column and position it was archived from and opens it, which is the only honest answer when that column is one the board does not draw.
Search is the only route back into the archive once the eight-second undo after archiving has passed.

The filter bar beside the Backlog control narrows the four visible columns rather than searching everything.
When a filter matches work the board has no column for, a line beneath it says how much is waiting in the Backlog or further back in Done, and opens the full search on the same query.

The visible filter bar can focus the board on unassigned work or work assigned to any team member, including the signed-in person.
Search and people filters combine, and the current view is stored in the URL so a useful view can be bookmarked or shared.
The open page or idea is part of the URL too, so copying the address bar sends a link that opens that exact page in the right view for any signed-in teammate.
Dragging remains available while filters are active, and visible drop targets map back to the full column order.
Press `1` for Work or `2` for Ideas globally or from an empty capture field.
An open dialog keeps the keyboard to itself, and `Escape` closes whichever one is in front.

## Chapters

Chapters are off until a project turns them on, and a project that never does sees no trace of them.

A chapter is a named stretch of the project's work, with optional dates, that a page can belong to.
It answers what the team was working on and roughly when, never how much was committed to.
There are no points, no estimates, no capacity, no velocity, no burndown, and no progress figure.
Dates are descriptive rather than binding: a chapter with neither a start nor an end is still a chapter, and one whose end date has passed keeps running until somebody closes it.

At most one chapter is open at a time.
Opening another closes the current one, as one deliberate action, which keeps chapters meaning "what are we working on now" rather than becoming a grid of parallel workstreams.
Any number of chapters can be planned ahead or kept after closing.

Belonging to a chapter is independent of a page's column.
A page can sit in the Backlog while already belonging to a chapter, so a chapter can be filled without flooding Up Next, and Up Next stays the small set of pages someone can pick up now.
The Backlog library gains a chapter filter and a one-click way to add any page to the chapter currently being viewed.

Closing a chapter never moves a page by itself.
It asks what should happen to the work that did not land, and every answer is a named choice: leave it here, move it to a planned chapter, or release it.
Dismissing the question does nothing, and no page is ever carried forward automatically.
Because nothing is moved out, a closed chapter stays an honest record of what was finished and what was not.

With chapters enabled, the work filter bar grows a chapter picker.
It lists the open chapter first, then planned ones, then closed ones newest first, alongside "All work" and the pages nobody has placed.
The board opens on the open chapter, so arriving lands on the current work, and "All work" is always one click away so the picker can never hide the project.
The selection is stored in the URL beside the search and people filters, so a chapter view can be bookmarked or shared.
Selecting a chapter replaces the page count above the board with the chapter's name, its dates, and what it is for.

Typing `~` in the capture field sets a chapter without leaving the keyboard.

## Ideas

The Idea garden keeps possibilities away from the work backlog until the team deliberately commits to one.
Every new idea lands in the Inbox and can move directly to the manually ranked Shortlist or to Parked.
Shortlisted ideas can be dragged into priority order without adding scores, votes, or ceremony.
Parked ideas remain searchable and recoverable without competing for attention.

Promoting an idea creates one Backlog page with the same title and Markdown notes.
The source idea is archived with a stable link to the created page, so the decision remains traceable without duplicating active content.
Promotion also offers an eight-second undo action that restores the source idea and removes the generated page.
If anyone edits or links work to the generated page, Grimoire protects that work and refuses the undo.
Ideas do not have assignees or work statuses because they are not work yet.

## Collaboration

The first person to open a new Grimoire installation creates the owner account.
The first-run form prefills `owner@example.com` as the owner email, while still allowing it to be edited before setup.
The project menu is a switcher: the projects, each with its one-line description, a collapsed "New project" field, and "Project settings".
Project settings is one dialog with a section rail — General, Categories, Page fields, Chapters, Team, Agent access, and a Danger zone — and the open section travels in the URL as `?settings=<section>`, so a reload or a shared link lands exactly where the reader was.
The header's `team` button is a shortcut into the same dialog, landed on its Team section.
Everything in settings saves as it is edited — on blur or Enter — and the dialog confirms each save with a quiet `saved` note in one fixed place; refusals appear in the same place and nowhere else.
General holds the project's name and its optional one-sentence description; categories and fields can be reordered; each chapter carries an editable intent line, the honest replacement for a sprint goal.
Members can open settings too and read every section an owner can reshape — the mutation controls, agent access, and the danger zone stay owner-only.
Archiving a project offers the same eight-second undo a page gets, and the Danger zone lists every archived project with a restore action, so archiving is no longer a one-way door.
The owner can create single-use invitation links from the Team section.
Only the newest unused invitation remains valid, and invitation links expire after seven days.
The owner can also remove members from the Team section, which revokes their sessions and live connections and clears their page assignments without erasing their authorship history.

Accounts, sessions, invitations, project membership, and the activity log are stored in a local SQLite database.
Pages and ideas are stored as Markdown files with validated YAML frontmatter.
Passwords are protected with scrypt, and browser sessions use HttpOnly SameSite cookies.
After signing in, open the account menu from the top-right avatar to change your password or sign out.
Changing a password requires the current password and signs the account out on other devices.

Signed-in browsers receive project-scoped live updates whenever another browser changes work or ideas.
The browser that made a change applies its own response directly, while every other connected browser reloads the affected workspace from the canonical Markdown files.

Two people can hold the same page or idea open without either of them losing writing.
An open editor sends only the fields someone actually rewrote, so renaming a page never carries a stale copy of its notes along with it.
A field nobody is rewriting simply adopts the incoming version and says who changed it, instead of sitting on a copy that would collide later.
When two people do write the same field, the second save is refused rather than applied: the editor shows what it collided with and offers to keep either version, and nothing reaches the file until someone chooses.
The same protection covers edits made outside Grimoire, so a change written straight into the Markdown by another editor survives a rename made in the browser.
Moving a page between columns or reordering one carries no text, so those stay immediate.

Teammates with the project open are ringed in green on the people filter bar and in the Team section of settings.
Presence is deliberately absent from the header, where it would mostly report the signed-in person back to themselves.
It follows the live connection itself, so it clears as soon as someone closes the tab or loses their network.

## While you were away

Opening a project after time away starts with a digest strip above the board: at most five human sentences describing what teammates changed, with the changes about you - new assignments and blockers that resolved - always first.
`+ N more` expands the strip in place, and dismissing it removes it completely for this visit.
Every page and idea changed while you were away carries a small accent dot; opening it clears its dot, dismissing the digest clears them all, and the next visit always starts clean.
The summary is driven by a private per-person cursor over the activity log, so nobody can see how caught up anyone else is, and your own actions never appear.
The cursor only advances while the tab is actually visible, so changes that arrive behind a hidden tab stay unseen until you return.
There are no emails, notifications, or push messages - Grimoire waits until you visit.

## Activity

The `activity` control in the header opens the project's history for the project owner, newest first and grouped by day.
Owners also see an unseen-change count on the control, and inside the history a `new since your last visit` line marks how far back to read.
Members keep the per-page history inside each page dialog; the project-wide log and its API are owner-only.
It records who created, edited, moved, archived, restored, and promoted every page and idea, along with project renames, category changes, invitations, joins, and removals.
Each entry names the fields that changed and what they changed from and to, and selecting a page entry opens that page.
Opening a page also shows its own recent history above the archive action.

Reordering a page inside a column, or reranking the shortlist, is not recorded, because a log shaped by dragging would bury the changes worth reading.
The history is kept in SQLite rather than the Markdown files and is never pruned.

## Page fields

A project can give its pages extra properties of its own — a priority, an estimate, a due day, whatever it tracks.
Fields are defined in Project settings in five shapes: text, a number, a choice from a fixed list, a day, or yes/no.
Grimoire names none of them, and nothing here is counted, added up, or rolled over: a number field is a number someone wrote down.

A field can be marked to show on board tiles, so a project can carry more than it puts on the board.
Renaming a field leaves every value alone.
Deleting one, or withdrawing a choice from a list, clears the values it left behind and says how many, rather than leaving pages holding an answer the project no longer offers.

## Team and roles

An owner can promote another member to owner, or demote one, from the Team section of settings.
The role decides who can reshape the project — its name, categories, chapters, fields, agent access, and membership — while everyone can work on pages and ideas.
Roles are account-wide by design, and the Team section says so where the button lives: making someone an owner grants owner powers on every project, not just the one on screen.
Changing your own role is refused: the one case worth allowing is a sole owner demoting themselves, which leaves nobody who can ever promote anyone again.

## Agent access

A project can let something without a browser write in it, which is how an AI agent reaches Grimoire.
The owner issues a credential in Project settings, and its secret is shown once and stored only as a hash.

A credential is a delegation rather than an account.
It belongs to one project and one person, every write it makes is attributed to that person, and the agent that made it is named beside them, so the history reads `Donavyn, via Planning agent, added ...`.
Nothing is ever assigned to an agent, because an assignee is the person responsible and an agent is not responsible for anything.
An agent never appears in the people filter, the Team section, or presence, because presence follows an open connection and an agent holds none.

An agent may create and edit pages and ideas, place a page into an existing chapter, and read the board, search, and its issuer's activity log.
It may never archive, restore, promote an idea, manage chapters or categories, invite or remove anyone, change the project, or touch an account.
The rule is that an agent adds and refines, and only a person destroys or restructures, which keeps a mistaken or runaway agent a mess rather than a catastrophe.
A credential can also be issued read-only, its writes are rate limited so a loop stays interruptible, and revoking it stops the agent immediately while leaving everything it already wrote correctly attributed.
Archiving a project suspends its credentials the same way, so no agent outlives the board it was given.

[packages/grimoire-mcp](packages/grimoire-mcp) is an MCP server that gives an agent these abilities as tools.
Its tools take the names a person would use for a category, chapter, member, or column and resolve them, and it is a plain client of the API above rather than a second way into the data.

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
Canonical project files are stored beneath `data/pages` by default.
Set `GRIMOIRE_CARDS_DIRECTORY` to a directory inside the Wizard Simulator repository if the work and ideas should share its Git history.

See [docs/architecture.md](docs/architecture.md) for the storage boundary, page format, migration behavior, and editing guarantees.
See [docs/deployment.md](docs/deployment.md) for the isolated Proxmox VM, Cloudflare Tunnel, automatic deployment, and backup procedure.

## Verification

```sh
npm test
npm run build
```

The test suite covers authentication, secure password changes, single-use invitations, member removal, Markdown persistence, legacy migration, external edits, live project events, presence, the activity log, the active deck, Backlog search, project-wide search, completion history, reversible archives and promotions, categories, page dependencies, assignments, filtering, idea ranking, ordering, drag-and-drop interaction, Markdown note rendering, pasted note images, concurrent editing and refused overwrites, the while-you-were-away digest, markers, and seen cursor, chapters including the per-project gate, the single open chapter, closing without rollover, and the compatibility of page files with a build that predates chapters, and agent access including project pinning, revoked and expired credentials, archived projects suspending their credentials, read-only scopes, the routes no credential may reach, a session outranking a bearer header, rate limited writes that survive a backwards clock step, use tracking on reads, credential events in the log under their own entity type, agent attribution rendered in the activity, page history and away surfaces, and attribution surviving both revocation and a rebuild of the activity log.

## Self-hosting

```sh
docker compose up -d --build
```

The Compose configuration exposes Grimoire on port `8080` and persists both SQLite identity data and Markdown pages in the local `data` directory.
Place Grimoire behind a TLS-enabled reverse proxy before inviting collaborators over the internet.
Production session cookies are marked Secure and require HTTPS.

Back up the `data` directory to preserve accounts, work, and ideas.
Do not run multiple Grimoire containers against the same SQLite file or project directory.
