# Self-hosting Grimoire

Grimoire is one process, one SQLite file, and one folder of Markdown.
This guide takes it from a checkout to an instance a team can reach, in the order most people need it: Compose first, then what changes once the address is public, then the route without Docker, then the care an instance needs over time.
Nothing here depends on a particular cloud or host.

## What you need

- A Linux host with Docker Engine and the Compose plugin, or Node.js 24 or newer for the route without Docker.
- About two GiB of memory while the image builds; the running service needs far less.
- A hostname with TLS in front of it, if anybody reaches the instance over the internet.

Grimoire does not publish a prebuilt image yet, so every install builds from the checkout.

## Compose

```sh
git clone https://github.com/donavynhaley/grimoire.git
cd grimoire
docker compose up -d --build
```

Open `http://<host>:8080`.
The first screen is **Create your Grimoire**, and the account it creates is the owner.
Whoever reaches the address first can claim it, so open it yourself before the address is shared, and only then invite the team.

`compose.yaml` publishes port 8080 and mounts `./data` into the container.
Everything the instance knows lives there: `data/grimoire.sqlite` holds accounts, sessions, and settings, and `data/cards/` holds every page and idea as Markdown.
Moving an instance is moving that directory.

Settings go in a `.env` file beside the Compose file.
[.env.example](../.env.example) lists every variable with its default and the reason it exists.

## Reaching it over the internet

Production session cookies are marked Secure, so a Grimoire on a plain HTTP address will not keep anyone signed in.
Put TLS in front of it, through either a reverse proxy or a tunnel, and tell Grimoire the proxy is there.

### A reverse proxy

Any proxy that terminates TLS and forwards to port 8080 works.
Caddy needs three lines:

```caddyfile
grimoire.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Then set `GRIMOIRE_TRUST_PROXY=1` in `.env`.
That setting decides who a failed sign-in is counted against.
Left unset behind a proxy, every visitor shares one allowance, and the first mistyped password slows the whole team down.
Set without a proxy, the limit can be stepped around by claiming an address.
It is a fact about the deployment rather than a preference, which is why it is configured and never guessed.

If the host itself should not answer on 8080, publish the port to loopback only, `127.0.0.1:8080:8080`, in a Compose override, and let the proxy be the only way in.

### A tunnel, with no open port

`compose.production.yaml` is the hardened arrangement.
The container runs read-only with every capability dropped, no port is published on the host, and a `cloudflared` sidecar carries traffic in through a Cloudflare Tunnel.
Create a remotely managed tunnel, point its public hostname at `http://grimoire:8080`, and put the token in `.env`:

```dotenv
TUNNEL_TOKEN=the-tunnel-token
```

```sh
docker compose -f compose.production.yaml up -d --build
```

The file refuses to start without the token rather than starting with the origin unreachable, so a missing `.env` is a failed start instead of a silent one.
`GRIMOIRE_TRUST_PROXY` is already set in that file, because the tunnel is the only thing that reaches the container and it forwards the visitor's address.

The same read-only, dropped-capability shape works behind any proxy: swap the `cloudflared` service for your own ingress and publish the port to loopback.

### Single sign-on

Sign in as the owner and open **Settings → Sign-in**.
[docs/single-sign-on.md](single-sign-on.md) walks through it, per provider.
Register `https://<your-grimoire>/api/auth/oidc/callback` with the provider either way.
Pinning the provider in `.env` instead is documented there too; anything set in the environment wins and turns the settings screen read-only.

## Configuration

| Variable | Default | What it decides |
| --- | --- | --- |
| `HOST`, `PORT` | `127.0.0.1`, `8080` | Where the server listens. The Compose files set `HOST=0.0.0.0` so the container is reachable. |
| `GRIMOIRE_DATABASE` | `data/grimoire.sqlite` | The SQLite file for accounts, sessions, and settings. |
| `GRIMOIRE_PAGES_DIRECTORY` | `data/cards` | Where the project folders of Markdown live. Point it into a Git repository if the work should share that repository's history. `GRIMOIRE_CARDS_DIRECTORY` is still honoured for older installs. |
| `GRIMOIRE_TRUST_PROXY` | unset | Whether a forwarded address is believed. Set it to `1` behind a proxy or tunnel, and only there. |
| `GRIMOIRE_OIDC_*` | unset | Single sign-on pinned in the environment. See [.env.example](../.env.example). |
| `TUNNEL_TOKEN` | unset | Required by `compose.production.yaml` alone. |

## Without Docker

Node.js 24 or newer, on any platform it supports.

```sh
git clone https://github.com/donavynhaley/grimoire.git
cd grimoire
npm ci
npm run build
NODE_ENV=production HOST=0.0.0.0 PORT=8080 npm start
```

`npm run build` type-checks, lints, and bundles both the interface and the server, and `npm start` runs the bundle from `server-dist/`.
The data directory is created beside the checkout on first start, at the default paths above.
Set the variables in the environment; a systemd unit is the usual way to keep them with the service and to bring it back after a reboot:

```ini
[Unit]
Description=Grimoire
After=network-online.target

[Service]
User=grimoire
WorkingDirectory=/opt/grimoire
EnvironmentFile=/opt/grimoire/.env
Environment=NODE_ENV=production HOST=0.0.0.0 PORT=8080
ExecStart=/usr/bin/node --enable-source-maps server-dist/index.js
Restart=always

[Install]
WantedBy=multi-user.target
```

## Backups

The `data` directory is the whole instance: the SQLite file and the Markdown folders.
A copy of a live SQLite file is not a restore point, so stop the server for the few seconds the copy takes:

```sh
docker compose stop
tar -C . -czf /somewhere/else/grimoire-$(date +%F-%H%M%S).tar.gz data
docker compose start
```

Keep the archive somewhere other than the host it came from.
Restore by stopping the server, putting the `data` directory back, and starting it again.
The paths inside the archive are the ones the server reads, so nothing else changes.
Rehearse that on a spare directory now and then, because a backup that has never been restored is not yet known to be usable.

A board of six hundred pages is under three megabytes of Markdown, and the database is well under one, so the archive stays small and a daily cron line is enough.
The pages directory can also live inside a Git repository through `GRIMOIRE_PAGES_DIRECTORY`, which gives the work itself a history and a remote without any of the above.

## Keeping it current

Upgrading is pulling a newer commit and rebuilding.
The database updates its own schema when the server starts, and the Markdown files are read as they are.

```sh
git pull
docker compose up -d --build
```

Compose builds the new image before it replaces the running container, so a build that fails leaves the old one serving.
The instance answers `GET /api/health` with 200 once it is up; that is what the health check in the Compose files polls, and what a deploy script can wait on.

To follow a branch without a hand on it, a timer that pulls and rebuilds when the branch has moved is all it takes.
The reference instance takes the other route: a private downstream repository merges this one's `main` when its operator decides to, and its own deploy runs from there, so an update is a deliberate merge rather than a timer.
Either works; the timer suits an instance that should track the project, the merge suits one that should move only when you say so.

```ini
# /etc/systemd/system/grimoire-update.service
[Unit]
Description=Rebuild Grimoire when the deploy branch has moved

[Service]
Type=oneshot
User=grimoire
WorkingDirectory=/opt/grimoire
ExecStart=/bin/sh -c 'git fetch -q origin main; [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] && exit 0; git reset -q --hard origin/main; docker compose up -d --build --remove-orphans'
```

```ini
# /etc/systemd/system/grimoire-update.timer
[Unit]
Description=Check for a new Grimoire every five minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
```

Every rebuild leaves layers in Docker's build cache, and nothing reclaims them on its own.
A weekly `docker builder prune --force --filter until=168h` keeps the cache to what makes the next build fast.

## Two things not to do

Do not run two Grimoire processes against one data directory; both the database and the Markdown writer assume a single writer.
Do not put the instance on a plain HTTP address and expect anyone to stay signed in; the Secure cookie is doing what it should.
