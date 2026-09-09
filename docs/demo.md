# Public demo

The public demo is a disposable, read-only copy of Grimoire with a fictional board.
Visitors arrive directly on the board without creating an account.
A banner explains that changes are disabled and links to the source for running an instance.

The gateway signs in as the seeded member, never as the owner.
It passes only listed browsing routes and attention markers, strips visitor credentials, and never sends its upstream session cookie to the browser.
All other API requests return 403, including account changes, invitations, settings, uploads, and work mutations.
The application remains unchanged; this gateway belongs only to the demo deployment.

## Start it

Use a dedicated checkout with Docker Engine, Compose, and `flock` available.
Do not use the production checkout or its data.

```sh
scripts/reset-public-demo.sh
```

This builds the image, recreates only the `grimoire-public-demo` Compose project's named volume, starts the application, seeds it over its real API, and starts the gateway.
Only the gateway is published, at `127.0.0.1:8098`.
The application has no host port, and the internal Docker network blocks outbound access to production services and integrations.
No production secrets, tunnel token, or data mounts belong in this stack.

Put a TLS reverse proxy in front of the gateway:

```caddyfile
demo.example.com {
    reverse_proxy 127.0.0.1:8098
}
```

Point the chosen public hostname at that host and verify HTTPS from another machine before linking the demo in the README or launch posts.
The ordinary `compose.demo.yaml` is a local development tool with known owner credentials and must not be exposed publicly.

## Reset nightly

Install the following units after replacing the user and checkout paths for the demo host.
The reset takes the demo offline briefly, and an unsuccessful seed leaves the gateway down.
The previous instance keeps serving if the image build fails.

```ini
# /etc/systemd/system/grimoire-demo-reset.service
[Unit]
Description=Reset the disposable Grimoire public demo
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
User=grimoire
WorkingDirectory=/opt/grimoire-demo
ExecStart=/opt/grimoire-demo/scripts/reset-public-demo.sh
TimeoutStartSec=15min
```

```ini
# /etc/systemd/system/grimoire-demo-reset.timer
[Unit]
Description=Refresh the Grimoire public demo nightly

[Timer]
OnCalendar=*-*-* 04:00:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now grimoire-demo-reset.timer
```

Monitor `GET /api/health` through the public gateway and alert on a failed reset unit.
After deployment and each upgrade, verify the board and a discussion in a new browser, confirm a write returns 403, and check that the gateway never returns a session cookie.
A working health endpoint alone does not prove that the anonymous board can be read.
