# Single sign-on

Grimoire signs people in through any OpenID Connect provider. It is part of Grimoire, it is not
a paid tier, and it is not going to become one.

Setting it up is three values and one address, and Grimoire reads everything else from the
provider itself.

## The short version

1. Sign in as the admin — the account that set Grimoire up — and open **Settings → Sign-in**.
2. Copy the **redirect address** shown at the top of that screen.
3. In your provider, create an application: OpenID Connect, confidential, authorization code
   flow, and paste that redirect address into it.
4. Back in Grimoire, paste your provider's address and press **check**. Grimoire reads the rest
   of the configuration from the provider and tells you what it found.
5. Paste the **client id** and **client secret** your provider gave you.
6. Turn it on. A **continue with …** button appears on the sign-in screen.

Password sign-in stays exactly where it was. Turning a provider on adds a second way in and
never removes the first, so a provider that goes down cannot lock you out of your own Grimoire.

## The redirect address

```
https://your-grimoire.example.com/api/auth/oidc/callback
```

This is the value most setups get wrong, so the settings screen shows the exact one for your
installation rather than describing it. It has to match what your provider has registered to
the character — the scheme, the host, any port, the whole path.

If Grimoire sits behind a reverse proxy or a tunnel and the address it works out is not the
address people actually use, set `GRIMOIRE_OIDC_REDIRECT_URI` to the right one and it will use
that instead.

## Who gets an account

Accounts are matched by **email address**. Somebody who has been signing in with a password
keeps their history, their memberships, and their name the moment single sign-on is turned on.
The provider signs them in; it does not replace them.

For somebody with no account yet, there are two settings and they answer different worries.

**Give an account to anyone your provider vouches for** is on by default. A team that has just
pointed Grimoire at their own identity provider has already decided who is allowed in, and
making each of them also click an invitation link is asking the same question twice.

**Allowed email domains** is the guard that makes that safe. Left empty, anybody your provider
vouches for can sign in. That is right when the provider is only your team. It is wrong the
moment the provider is shared — pointed at Google, or at a tenant that is not only yours, the
default means *anybody with an account there*. Naming your domains closes that.

Turn auto-registration off to keep Grimoire invitation-only: the provider then signs in accounts
that already exist, and an invitation link is still what creates a new one.

## Configuring it in a file instead

Everything the settings screen writes can be set in the environment instead, for a deployment
that would rather describe itself in a file. Anything set there **wins**, and the settings screen
becomes read-only and says so, so the two can never disagree about what is in force.

```dotenv
GRIMOIRE_OIDC_ISSUER=https://id.example.com
GRIMOIRE_OIDC_CLIENT_ID=grimoire
GRIMOIRE_OIDC_CLIENT_SECRET=the-client-secret
GRIMOIRE_OIDC_LABEL=Authentik
GRIMOIRE_OIDC_ALLOWED_EMAIL_DOMAINS=example.com
```

A half-written configuration stops the server rather than starting without the button, because a
sign-in option that quietly never appears is the hardest kind of mistake to notice. Every
variable is listed in [.env.example](../.env.example).

## Your provider

Grimoire needs the same four things everywhere: an application of type OpenID Connect, the
authorization code flow, the redirect address above, and the `openid email profile` scopes.
What each provider calls those differs.

### Authentik

Create an **OAuth2/OpenID Provider**, then an **Application** pointing at it.

- Client type: **Confidential**
- Redirect URI: the address above, as a **Strict** match
- Signing key: any; Grimoire reads the algorithm from your provider
- Scopes: `openid`, `email`, `profile`

Paste `https://authentik.example.com/application/o/<application-slug>/` as the provider address.

### Keycloak

Create a **Client** in your realm.

- Client authentication: **On** (this makes it confidential)
- Standard flow: **enabled**
- Valid redirect URIs: the address above
- Client id and secret: from the **Credentials** tab

Provider address: `https://keycloak.example.com/realms/<realm>`

### Authelia

Add Grimoire to `identity_providers.oidc.clients` in your Authelia configuration.

- `client_id`: `grimoire`
- `client_secret`: a hashed secret, per Authelia's documentation
- `redirect_uris`: the address above
- `scopes`: `openid`, `email`, `profile`

Provider address: `https://auth.example.com`

### Pocket ID

Create an **OIDC Client**.

- Callback URL: the address above
- Copy the client id and secret it shows you

Provider address: `https://id.example.com`

### Google

Create an **OAuth 2.0 Client ID** of type *Web application* in the Google Cloud console, with
the address above as an authorized redirect URI.

Provider address: `https://accounts.google.com`

**Set allowed email domains.** Google will vouch for every Google account there is, so without
that list, auto-registration means anybody at all.

### Microsoft Entra ID

Register an application, add a **Web** redirect URI with the address above, and create a client
secret under *Certificates & secrets*.

Provider address: `https://login.microsoftonline.com/<tenant-id>/v2.0`

## When it does not work

**"No provider configuration at …"** — Grimoire looked for `/.well-known/openid-configuration`
under the address you gave and found nothing. Some providers publish it somewhere else; paste
that full URL instead of the issuer and Grimoire will use it as given.

**"The provider at X calls itself Y"** — the address you pasted and the issuer the provider
reports are different strings, which is a mismatch every OpenID client will refuse. Use the name
the provider gives, which the message quotes.

**redirect_uri mismatch, from the provider** — the address registered with the provider is not
the one Grimoire sent. Compare it against the redirect address on the settings screen, character
for character, and set `GRIMOIRE_OIDC_REDIRECT_URI` if a proxy is rewriting it.

**"The sign-in provider has not verified that email address"** — the provider said
`email_verified: false`. Accounts are matched by email, so an address the provider will not
vouch for is refused; verify it with your provider.

**The check passes but signing in fails** — the check reaches the provider and reads its
configuration, which is all it can do. The client id and secret are only exercised by an actual
sign-in, and a wrong one shows up there. The message on the sign-in screen says which.

**You cannot get in at all** — sign in with your password. That form is never hidden and never
disabled, which is exactly what it is for.
