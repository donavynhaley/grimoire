# Releases and compatibility

## The v1.0 promise

The Markdown page format and the project-scoped agent API are stable in Grimoire 1.x.
Supported upgrades preserve your data: pages, ideas, attachments, discussions, accounts, and project settings.
A release that requires an operator action documents it before the upgrade.
Back up the whole instance and rehearse recovery using the [operator guide](operations.md).

Within 1.x, existing documented fields and agent operations retain their meaning.
New optional fields and new operations may be added.
Clients must tolerate additional response fields.
An incompatible change to the documented format or agent API requires a major release and migration instructions.
Internal database tables, CSS, and undocumented browser implementation details are not a public API.
The separately versioned MIT-licensed MCP package remains a client of the agent API; its package version is not the application's version.

The promise concerns supported forward upgrades, not running an older binary against newer migrated data.
Rollback restores a pre-upgrade backup together with its matching application version.

## Release process

The public upstream owns releases.
The private deployment downstream does not run the Release workflow.
Release Please reads `release-please-config.json` and `.release-please-manifest.json`, opens a version PR, and generates `CHANGELOG.md`.
Do not edit the changelog by hand.
The application version, lockfile, manifest, and generated changelog land together in that PR.

The first public release used a one-time `release-as` override to select 1.0.0.
Later releases follow conventional commits and the version recorded in the manifest.
Do not transplant the old private repository's staged release PR or tags into the scrubbed repository; regenerate from its clean history.

Before merging the release PR:

1. Run `npm ci`, `npm test`, `npm run build`, and the MCP package's install and verification commands on the proposed release.
2. Run `npm run test:e2e` locally, and verify a production container and restore rehearsal.
3. Confirm that the generated changelog has no private links or information.
4. Complete the public repository's security and visibility checklist.
5. Merge the release PR only when the version is ready to publish.

## The MCP package

`packages/grimoire-mcp` is versioned separately from the application and published to npm.

It is its own Release Please package, so it takes its version from commits that touch its directory rather than from the application's.
Its tags carry the component name, `grimoire-mcp-v0.4.0`, while the application's stay bare, `v1.2.0`.
`bootstrap-sha` records where its managed history begins, because the package existed and was published by hand before Release Please owned it.

Publishing follows the tag rather than a person.
The Publish grimoire-mcp workflow runs when the GitHub release for a `grimoire-mcp-v*` tag is published, type checks the package, and publishes it with provenance.
It needs an `NPM_TOKEN` secret with publish rights to `grimoire-mcp`; without it the workflow fails at the publish step and the registry keeps the previous version.
Releases for the application share the trigger and are filtered out by the tag prefix, so cutting an app release never publishes the package.

This arrangement exists because the two drifted apart: the registry served 0.3.0 from August while the tree had grown the attachment tools and a second binary, and nothing in the repository was responsible for noticing.

Release Please then creates the tag and GitHub release from the merged PR.
Include the v1.0 promise above in the release description before announcing it.
The default `GITHUB_TOKEN` does not trigger another workflow from a bot-created PR; close and reopen that PR as a maintainer to start its normal CI checks before merging it.
Enable GitHub Actions' permission to create pull requests in the upstream repository settings.
