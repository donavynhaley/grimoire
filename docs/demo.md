# Public demo

Every Grimoire installation serves an editable playground at `/demo`.
The sign-in screen offers **Try the demo**, and the route also works directly without an account.
Visitors use the ordinary board interface as Alex, the fictional owner of The Lantern Workshop.
They can change pages, ideas, discussions, categories, custom fields, chapters, and local projects.

The banner explains that changes stay in the current tab.
**Reset demo** restores the sample data after confirmation.
**Back to sign in** returns to the ordinary application without signing out an existing real session.
If the visitor was already signed in, they return to their real board.

## Browser storage and isolation

Demo changes are recorded in the tab's `sessionStorage` under `grimoire.demo.v1`.
Refreshing replays validated commands over the seed; closing the tab normally discards its playground.
Browsers may restore session storage when restoring a closed tab, and duplicating a tab can copy its initial state.
Those copies do not share subsequent changes.
The demo never uses `localStorage`, real account cookies, the production API, or the live event stream.
Unknown operations fail locally rather than falling back to HTTP.

If storage is unavailable or full, changes continue in memory with a visible explanation that further changes will not survive refresh.
Invalid or incompatible saved data starts a fresh demo and tells the visitor.
The command journal is limited to 1,000 changes and 4 MB for persistence; images are limited to 2 MB each.
Uploaded PNG, JPEG and WebP images stay in the local journal.
Remote and API-backed images embedded in demo notes are not loaded.

Features requiring real services explain their purpose instead of collecting credentials or pretending to connect.
Invitations, new real members, agent credentials, GitHub, Discord, imports and installation sign-in settings belong on a real installation.
Existing sample teammates can be assigned work or have their local project roles changed.

## Deployment

Deploy the application normally and visit `/demo` on its existing hostname.
No extra service, tunnel, database, seed command, or scheduled reset is needed.
The server's existing single-page-application fallback serves the route; normal API authentication is unchanged.

The earlier standalone read-only gateway has been retired from the source tree.
An operator with that older stack running can retire its dedicated containers and reset schedule after the new route has been verified.
Do not remove production data or the production tunnel.
The separate `compose.demo.yaml` remains a local development fixture with sample owner credentials, not the public playground.

Before promoting an update from public upstream into a private deployment, review its PR and verify `/demo` locally.
After the private CI and deployment complete, check the sign-in link, editing, refresh, reset, and return to a real session on the hosted route.
The browser suite checks desktop and mobile flows, separate visitors, and isolation while signed in.
