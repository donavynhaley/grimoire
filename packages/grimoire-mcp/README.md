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
| `grimoire_board` | The whole project: every page with its column, category, chapter, assignee and blockers, plus the categories, chapters and members that exist |
| `grimoire_search` | Searches titles and note bodies across every column, the backlog, the idea garden, completed work, and archived pages |
| `grimoire_create_page` | Adds a unit of work |
| `grimoire_update_page` | Edits an existing page |
| `grimoire_move_page` | Moves a page between columns |
| `grimoire_list_ideas` | Reads the idea garden |
| `grimoire_create_idea` | Captures a possibility without committing to it |

Category, chapter, assignee, and blockers all take the names a person would use, and are resolved against the board.
`"me"` resolves to the person the token acts as.
An unrecognised name is refused with the real options listed, rather than guessed at.

## What an agent cannot do

There is no tool for archiving, promoting an idea, or managing chapters, categories, or membership, and the server refuses those routes to a token whatever its scope.

The rule is that **an agent may add and refine, and only a person may destroy or restructure**.
Archiving is the sharpest case: its undo lasts eight seconds and is built for a person who just clicked, so an agent that archived thirty pages would leave no path anyone would find.
Promotion is the deliberate act of committing to an idea, which is the entire point of keeping the idea garden separate from work.

A token issued with the `read` scope can call the reading tools only.

## Editing something a person is also editing

Rewriting a title or notes takes an optional `expectedTitle` / `expectedNotes`: what you were editing from.
If someone changed that field in the meantime, the write is refused and the stored version is returned, rather than replacing their words.

The right response is to re-read, decide what the merged text should be, and send it again with the new expectation.
Retrying the same write unchanged would only be last-writer-wins with extra steps.

## Rate limiting

Writes are limited per token, with a burst allowance.
Going past it returns a message asking the agent to wait, and writes nothing.
This exists so a looping agent stays interruptible, not to ration ordinary use.
