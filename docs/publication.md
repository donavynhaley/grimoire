# Publishing the upstream

The upstream is `donavynhaley/grimoire`.
The private `donavynhaley/grimore` repository remains the reference instance's deployment downstream.
Never change the private repository's visibility or push its old branches or tags into the upstream.

## History scrub

Work on a fresh isolated clone after the launch preparation has landed.
Publish only the cleaned main branch.
Remove these paths from every historical commit with `git filter-repo --sensitive-data-removal --no-fetch --invert-paths` in the isolated, main-only clone:

- `public/profile-icons/`
- `.live/`
- `docs/mobile-pass.html`
- `.lavish/`
- `docs/deployment.md`
- `.github/workflows/deploy.yml`
- `ops/ensure-actions-runner.sh`
- `ops/prune-docker-cache.sh`

Also exclude deployment-specific import scripts and their fixtures; retain the exact private path list in the operator audit record.
Restore only the current original avatar assets after removing the historical avatar directory.
Scan for additional historical databases, credentials, private configuration, and private work records before choosing the final exclusion list.
Run Gitleaks across every retained commit, then manually inspect residual private domains, addresses, and identifiers in file contents and commit messages.
Keep scanner reports and commit maps outside the published repository.
Commit attribution and the explicitly published Code of Conduct contact are intentional identity metadata, not application defaults.
Do not carry private release notes or commit links into a generated public release.

## Public repository settings

Before changing visibility, prepare the description, homepage, topics, and a 1280 by 640 social preview.
Enable Discussions, private vulnerability reporting, dependency alerts, and automatic security fixes.
The tree includes CodeQL and Dependabot configuration.
Set the default Actions token to read-only, allow Actions to create release PRs, and require the CI `verify` check on main with force pushes and deletion blocked.
Enable secret scanning and push protection as soon as the repository's visibility and plan make them available.
Verify each setting through GitHub after writing it.

Create a clean `cla-signatures` branch before accepting contributions; do not copy private repository branches wholesale.
Follow [the release procedure](releases.md) to generate the changelog and publish v1.0.0 from clean history.

## Private deployment downstream

Preserve old private main as `archive/pre-scrub`.
Rebuild private main from public main plus one overlay commit containing only the three excluded deployment files.
Keep CI enabled because Deploy waits for it, and disable Release and CLA in the private repository settings.
Keep the existing runner and production checkout location.
Use an exact force-with-lease for this one-time history replacement, after checking the remote has not moved.
Subsequent updates are ordinary reviewed merges from public main.

Move development checkouts and the board's GitHub repository setting to the public upstream after outstanding private PRs have landed.
The project's local agent mapping must point to the actual development checkout.

## Launch

Verify the public clone and quickstart without credentials, inspect the demo from another network, and exercise backup and restore before announcing the release.
Use the demo link in the launch post only after its hostname, TLS, reset timer, and monitoring are verified.
