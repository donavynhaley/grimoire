# Security

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's security advisories:
[github.com/donavynhaley/grimore/security/advisories/new](https://github.com/donavynhaley/grimore/security/advisories/new).
Please do not open a public issue or pull request for a security problem — a
public report is a disclosure, and a fix should exist before one of those does.

You can expect an acknowledgement within a few days. Grimoire is maintained by
one person, so a fix may take longer than a team would need, but you will not be
left wondering whether the report was read. There is no bug bounty.

Only the latest release is supported. Grimoire deploys continuously from `main`,
and a fix ships as the next release rather than being backported.

## What you should know before exposing an installation

Grimoire is built for a small team that already trusts each other, and its
security posture is written down here honestly rather than implied. The
Verification section of the README lists the tests that hold each of these
claims true.

**What it does:**

- Passwords are stored as scrypt hashes. Sign-in failures are rate limited,
  counted against both the address they came from and the account they name.
- Every response carries a Content-Security-Policy. The build ships no inline
  script and calls nothing off its own origin.
- Agent credentials are shown once at issue and stored only as a hash. They are
  scoped to one project, attributed to one person, rate limited on writes, and
  revocable immediately.
- Single sign-on is authorization code with PKCE; the code is exchanged server
  to server, and the identity token is verified against the provider's published
  keys — issuer, audience, expiry, and nonce — before a word of it is believed.
- Production session cookies are marked Secure and require HTTPS.

**What it does not do:**

- Integration secrets that Grimoire must present to other services — a project's
  GitHub token, its Discord webhook URL, the OIDC client secret — are stored
  unencrypted in the SQLite database. They have to be replayable to be useful,
  and Grimoire does not pretend a reversible encryption layer beside its own key
  would change who can read them. Anyone who can read the `data/` directory has
  these secrets, along with every page and every discussion. Protect that
  directory and its backups accordingly.
- There is no two-factor authentication.
- There is no TLS in the container. Grimoire expects to sit behind a
  TLS-terminating reverse proxy or tunnel, and behind one you should set
  `GRIMOIRE_TRUST_PROXY=1` so the sign-in rate limit counts the visitor rather
  than the proxy.

If any of the claims above stops being true, this file changes in the same pull
request — the same rule the rest of the documentation lives under.
