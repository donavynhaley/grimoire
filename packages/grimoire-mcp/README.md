# grimoire-mcp

An MCP server that lets an AI agent read and write one Grimoire project.

It is a plain HTTP client of Grimoire's ordinary API.
It never opens the SQLite database or the Markdown directory, so every write it makes goes through the same validation, activity log, and live broadcast that a browser's writes do.

## Giving an agent access

Agent access is granted per project, by the project owner, in **Project settings → Agent access**.

Issuing a credential gives you a secret beginning `grim_`.
It is shown once and never again, because only its hash is stored.

A token belongs to a person as well as a project.
Everything the agent writes is attributed to whoever issued the token, with the agent's name recorded beside it, so the activity log reads *"Donavyn, via Planning agent, added …"*.
Revoking the token stops the agent immediately and leaves its past work correctly attributed.

## Connecting a client

The server speaks stdio, so the client runs it as a process and nothing new is exposed on the network.

```json
{
  "mcpServers": {
    "grimoire": {
      "command": "node",
      "args": ["/path/to/grimoire/packages/grimoire-mcp/dist/index.js"],
      "env": {
        "GRIMOIRE_URL": "https://grimoire.example.com",
        "GRIMOIRE_TOKEN": "grim_..."
      }
    }
  }
}
```

For Claude Code, the same thing:

```sh
claude mcp add grimoire \
  --env GRIMOIRE_URL=https://grimoire.example.com \
  --env GRIMOIRE_TOKEN=grim_... \
  -- node /path/to/grimoire/packages/grimoire-mcp/dist/index.js
```

| Variable | Required | Meaning |
| --- | --- | --- |
| `GRIMOIRE_URL` | yes | Where Grimoire is served, e.g. `http://127.0.0.1:8080` |
| `GRIMOIRE_TOKEN` | yes | The `grim_…` secret from Project settings |
| `GRIMOIRE_PROJECT` | no | A project id. A token is already pinned to its own project, so this only ever confirms it |

Build it first with `npm install && npm run build` in this directory.

## Tools

| Tool | What it does |
| --- | --- |
| `grimoire_board` | The whole project: every page with its column, category, chapter, assignee, blockers and field values, plus the categories, chapters, fields and members that exist |
| `grimoire_search` | Searches titles and note bodies across every column, the backlog, the idea garden, completed work, and archived pages |
| `grimoire_read_page` | One page's title and complete notes, exactly as stored - the values to pass as `expectedTitle` / `expectedNotes` when rewriting |
| `grimoire_create_page` | Adds a unit of work |
| `grimoire_update_page` | Edits an existing page, including the GitHub work it is tied to |
| `grimoire_move_page` | Moves a page between columns |
| `grimoire_list_ideas` | Reads the idea garden |
| `grimoire_create_idea` | Captures a possibility without committing to it |

Category, chapter, assignee, and blockers all take the names a person would use, and are resolved against the board.
`"me"` resolves to the person the token acts as.
An unrecognised name is refused with the real options listed, rather than guessed at.

A project can also define its own fields - a priority, an estimate, a due day, whatever it tracks - and `grimoire_create_page` and `grimoire_update_page` take them as `fields`.
A field can be named by its key or by the label a person reads, and a choice field's option can be given in any casing, so `{ "Priority": "P0" }` and `{ "priority": "p0" }` are the same write.
Anything else is refused with the real options listed.
`fields` is a patch: naming one field leaves every other one alone, which matters because an agent rarely knows what the rest of them hold. `null` clears one.
A page is named by its id or its exact title - a partial title is refused with the close matches listed, because these tools rewrite bodies and a half-remembered word must never silently land on whichever page happens to contain it.

## Tying a page to the work that delivers it

`grimoire_update_page` takes a `github` argument: a pull request URL, `#123`, a branch URL, or a branch name.
`null` unlinks.
A URL naming another repository is kept, so a page may point across repositories; the bare forms lean on the project's configured one.

This is where a pull request belongs, rather than in a line of the notes.
A real link is tracked: Grimoire caches what GitHub last said about it, shows it on the page, and moves the page along the two edges the automation owns - into **Review** when the pull request opens, and into **Done** once it merges.
Both fire on the transition and never merely because the state still holds, so a hand that pulls a page back out of Review keeps it there.
A draft pull request moves nothing.
A link written into the notes instead does none of this, and goes stale the moment the pull request does anything.

`grimoire_board` and `grimoire_read_page` both show an existing link and its last known state, so an agent can tell a linked page from an unlinked one before deciding to write.

Linking is a property of the page, so it sits on the agent's side of the line.
The automation moving a merged page into Done is GitHub's edge, recorded against the actor `GitHub` - not an agent making the one move that is reserved for a person.

## What an agent cannot do

There is no tool for archiving, promoting an idea, or managing chapters, categories, fields, or membership, and the server refuses those routes to a token whatever its scope.
Managing is the closed half: an agent editing a page may still place it into an existing chapter or category and take it out again, and fill in any field the project defined, because all of those are properties of the page.
Deciding which fields exist is deciding what the project records about its work, which is the same kind of decision as adding a column.

The rule is that **an agent may add and refine, and only a person may destroy or restructure**.
Archiving is the sharpest case: its undo lasts eight seconds and is built for a person who just clicked, so an agent that archived thirty pages would leave no path anyone would find.
Promotion is the deliberate act of committing to an idea, which is the entire point of keeping the idea garden separate from work.

A credential issued with the `read` scope is registered only the reading tools - the server asks Grimoire for its scope at startup, so a read-only agent never has to discover its limits by being refused.

## Editing something a person is also editing

Rewriting a title or notes **requires** `expectedTitle` / `expectedNotes`: the value read from `grimoire_read_page` before deciding to rewrite it.
A rewrite that declares no expectation is refused outright, because a precondition invented from a value read microseconds earlier can never fire and would be last-writer-wins wearing a safety's clothes.
If someone changed the field after it was read, the write is refused and the stored version is returned, rather than replacing their words.

The right response is to re-read, decide what the merged text should be, and send it again with the new expectation.
Retrying the same write unchanged would only be last-writer-wins with extra steps.

## Verification

```sh
npm run verify
```

Starts a real Grimoire, issues a real credential through the real route, and then speaks MCP over stdio to the built server, checking the effects landed.
It covers the handshake and the tool list, resolving names to identifiers, creating, editing, moving and searching, attribution reaching the activity log, refusals that list the real options, a rewrite without an expectation being refused, a stale expectation being refused and then landing after a re-read, a partial title being refused rather than guessed, tying a page to a pull request and reading the link back off the board, an unreadable reference being refused and `null` unlinking, the routes no credential may reach, revocation taking effect immediately, a read-scoped credential being offered only the reading tools, and an archived project suspending its credentials.
CI runs it on every push, after the main suite.

## Rate limiting

Writes are limited per token, with a burst allowance.
Going past it returns a message asking the agent to wait, and writes nothing.
This exists so a looping agent stays interruptible, not to ration ordinary use.
