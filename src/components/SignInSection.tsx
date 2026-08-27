import { useEffect, useState } from "react";
import type { OidcProviderDescription, OidcSettings } from "../../shared/types";
import { oidcSettings, probeOidcProvider, saveOidcSettings } from "../api/client";
import { Growing } from "./Growing";
import type { SettingsRun } from "./use-settings-action";

/**
 * Turning single sign-on on, in the place somebody would look for it.
 *
 * The whole design of this screen is an answer to how these setups actually fail. They fail
 * on a redirect address that does not match to the character, so the address is shown first
 * and can be copied rather than retyped. They fail on the seven endpoint URLs a provider
 * publishes and a person transcribes, so those are read from the provider instead of asked
 * for. And they fail silently, hours later, when somebody tries to sign in - so the check
 * happens here, before anything is saved, and says what it actually found.
 *
 * Two fields are left to be typed, because no provider will tell us them: the client id and
 * the secret.
 */
export function SignInSection({ run }: { run: SettingsRun }) {
  const [settings, setSettings] = useState<OidcSettings | null>(null);
  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [label, setLabel] = useState("");
  const [domains, setDomains] = useState("");
  const [probe, setProbe] = useState<OidcProviderDescription | "checking" | { error: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [showingSetup, setShowingSetup] = useState(false);

  const adopt = (next: OidcSettings) => {
    setSettings(next);
    setIssuer(next.issuer);
    setClientId(next.clientId);
    setLabel(next.label);
    setDomains(next.allowedEmailDomains);
    setShowingSetup((showing) => showing || !next.issuer);
  };

  useEffect(() => {
    let live = true;
    void oidcSettings()
      .then(({ settings: loaded }) => {
        if (live) adopt(loaded);
      })
      .catch(() => {
        if (live) setSettings(null);
      });
    return () => {
      live = false;
    };
  }, []);

  if (!settings) return <div className="settings-section"><p className="chapters-note">Reading the sign-in settings...</p></div>;

  const managed = settings.source === "environment";

  /*
   * The address as this browser knows it, which is the only place it is known for certain.
   *
   * The server can only infer its own public address from headers a proxy may or may not be
   * writing, and an inferred scheme or port that is one character off is precisely the failure
   * this whole screen exists to prevent. The admin's browser is not guessing: it is looking at
   * the real address right now. So that is what is shown, and it is pinned the first time
   * anything here is saved - which makes the string registered with the provider and the string
   * sent in the flow the same string by construction, rather than by two derivations agreeing.
   */
  const browserCallback = `${location.origin}/api/auth/oidc/callback`;
  const callbackUrl = managed ? settings.callbackUrl : settings.redirectUri || browserCallback;

  const save = (input: Partial<OidcSettings> & { clientSecret?: string }) =>
    run(async () => {
      const pin = settings.redirectUri ? {} : { redirectUri: browserCallback };
      const { settings: saved } = await saveOidcSettings({ ...pin, ...input });
      adopt(saved);
    }, "The sign-in settings could not be saved");

  const check = async () => {
    const address = issuer.trim();
    if (!address) return;
    setProbe("checking");
    try {
      const result = await probeOidcProvider(address);
      setProbe(result.provider ?? { error: result.error ?? "That address could not be read." });
      // A provider that answered is worth keeping even before the rest is filled in, so a
      // half-finished setup survives closing the dialog.
      if (result.provider) await save({ issuer: address, label: label.trim() || new URL(result.provider.issuer).hostname });
    } catch {
      setProbe({ error: "The check itself failed. Try again in a moment." });
    }
  };

  const copyCallback = async () => {
    try {
      await navigator.clipboard.writeText(managed ? settings.callbackUrl : settings.redirectUri || `${location.origin}/api/auth/oidc/callback`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const ready = settings.issuer !== "" && settings.clientId !== "";

  return (
    <div className="settings-section">
      <div className="github-intro">
        <p className="chapters-note">
          Let people sign in with the identity provider you already run. Password sign-in stays
          where it is: this adds a second way in, and never takes the first one away.
        </p>
        <button
          aria-expanded={showingSetup}
          aria-label={showingSetup ? "Hide setup instructions" : "How do I set this up?"}
          className="github-help"
          onClick={() => setShowingSetup((showing) => !showing)}
          title="How do I set this up?"
          type="button"
        >?</button>
      </div>

      <Growing className="github-setup-fold">
        {showingSetup && (
          <ol className="github-setup">
            <li>
              In your provider, create an application - Authentik calls it a <em>Provider</em>, Keycloak
              a <em>Client</em> - of type <strong>OpenID Connect</strong>, confidential, using the
              authorization code flow.
            </li>
            <li>Give it the redirect address below. It has to match exactly, including the scheme and any port.</li>
            <li>Paste the provider&apos;s address here and press check. Everything else is read from the provider.</li>
            <li>Paste the client id and secret it gave you, then turn it on.</li>
          </ol>
        )}
      </Growing>

      {managed && (
        <p className="settings-summary managed-note" role="status">
          This provider is configured in the environment, so it is changed there rather than here.
          What follows is what the server is using.
        </p>
      )}

      {/*
        First, and copyable, because a redirect address that does not match to the character is
        the way these setups fail most often and the hardest one to see afterwards.
      */}
      <div className="settings-row">
        <span className="field-label">Redirect address</span>
        <div className="callback-url">
          <code>{callbackUrl}</code>
          <button className="quiet-button" onClick={() => void copyCallback()} type="button">
            {copied ? "copied" : "copy"}
          </button>
        </div>
        <p className="settings-summary">
          Register this with your provider, exactly as it reads. It is the address you are
          reaching Grimoire at now; if your team uses a different one, set{" "}
          <code>GRIMOIRE_OIDC_REDIRECT_URI</code> to that.
        </p>
      </div>

      <div className="settings-row">
        <label className="field-label" htmlFor="settings-oidc-issuer">Provider address</label>
        <div className="settings-input">
          <input
            disabled={managed}
            id="settings-oidc-issuer"
            name="oidcIssuer"
            onChange={(event) => setIssuer(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void check(); } }}
            placeholder="https://id.example.com"
            value={issuer}
          />
          {!managed && (
            <button className="quiet-button" disabled={!issuer.trim() || probe === "checking"} onClick={() => void check()} type="button">
              {probe === "checking" ? "checking..." : "check"}
            </button>
          )}
        </div>
        <p className="settings-summary">
          The issuer, or its <code>.well-known/openid-configuration</code> URL if your provider
          keeps it somewhere else.
        </p>
        {probe !== null && probe !== "checking" && (
          "error" in probe ? (
            <p className="github-check-result failed" role="status">{probe.error}</p>
          ) : (
            <div className="provider-report" role="status">
              <p className="github-check-result ok">Answered as {probe.issuer}.</p>
              <ul>
                <li>Sign-in at <code>{probe.authorizationEndpoint}</code></li>
                <li>
                  {probe.signingKeyCount > 0
                    ? `${probe.signingKeyCount} signing key${probe.signingKeyCount === 1 ? "" : "s"} published`
                    : "No signing keys published"}
                  {probe.signingAlgorithms.length > 0 ? ` (${probe.signingAlgorithms.slice(0, 4).join(", ")})` : ""}
                </li>
                <li>{probe.supportsPkce ? "PKCE supported" : "PKCE not advertised - Grimoire sends it anyway"}</li>
              </ul>
              <p className="settings-summary">
                This says the provider is reachable and speaks the protocol. It cannot check the
                client id and secret; the first sign-in does that.
              </p>
            </div>
          )
        )}
      </div>

      <div className="settings-row">
        <label className="field-label" htmlFor="settings-oidc-client">Client id</label>
        <div className="settings-input">
          <input
            disabled={managed}
            id="settings-oidc-client"
            name="oidcClientId"
            onBlur={() => { if (!managed && clientId.trim() !== settings.clientId) void save({ clientId: clientId.trim() }); }}
            onChange={(event) => setClientId(event.target.value)}
            placeholder="grimoire"
            value={clientId}
          />
        </div>
      </div>

      <div className="settings-row">
        <label className="field-label" htmlFor="settings-oidc-secret">Client secret</label>
        <div className="settings-input">
          <input
            disabled={managed}
            id="settings-oidc-secret"
            name="oidcClientSecret"
            onBlur={() => { const next = secret.trim(); if (next) { setSecret(""); void save({ clientSecret: next }); } }}
            onChange={(event) => setSecret(event.target.value)}
            placeholder={settings.clientSecretSet ? "A secret is saved. Paste a new one to replace it." : "paste the secret"}
            type="password"
            value={secret}
          />
        </div>
        <p className="settings-summary">It stays on the server and is never shown again.</p>
      </div>

      <div className="settings-row">
        <label className="field-label" htmlFor="settings-oidc-label">Button text</label>
        <div className="settings-input">
          <input
            disabled={managed}
            id="settings-oidc-label"
            name="oidcLabel"
            onBlur={() => { if (!managed && label.trim() !== settings.label) void save({ label: label.trim() }); }}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="your provider's name"
            value={label}
          />
        </div>
        <p className="settings-summary">The sign-in screen reads &ldquo;continue with {label.trim() || "..."}&rdquo;.</p>
      </div>

      <div className="settings-row">
        <span className="field-label">New people</span>
        <label className="settings-toggle">
          <input
            checked={settings.autoRegister}
            disabled={managed}
            name="oidcAutoRegister"
            onChange={(event) => void save({ autoRegister: event.target.checked })}
            type="checkbox"
          />
          <span aria-hidden="true" className="settings-knob" />
          <span className="settings-toggle-label">
            {settings.autoRegister ? "given an account" : "invitation needed"}
          </span>
        </label>
        <p className="settings-summary">
          {settings.autoRegister
            ? "They join on first sign-in. Somebody who already has an account keeps it - accounts are matched by email, not replaced."
            : "Only people who already have an account, or who follow an invitation link, can get in."}
        </p>
      </div>

      <div className="settings-row">
        <label className="field-label" htmlFor="settings-oidc-domains">Allowed email domains</label>
        <div className="settings-input">
          <input
            disabled={managed}
            id="settings-oidc-domains"
            name="oidcAllowedEmailDomains"
            onBlur={() => { if (!managed && domains.trim() !== settings.allowedEmailDomains) void save({ allowedEmailDomains: domains.trim() }); }}
            onChange={(event) => setDomains(event.target.value)}
            placeholder="example.com"
            value={domains}
          />
        </div>
        <p className="settings-summary">
          {domains.trim()
            ? "Only these domains may sign in, whatever your provider says."
            : "Empty means any address your provider vouches for. Worth filling in if that provider is not only your team - a Google or a shared tenant."}
        </p>
      </div>

      <div className="settings-row">
        <span className="field-label">Sign-in</span>
        <label className="settings-toggle">
          <input
            checked={settings.enabled}
            disabled={managed || !ready}
            name="oidcEnabled"
            onChange={(event) => void save({ enabled: event.target.checked })}
            type="checkbox"
          />
          <span aria-hidden="true" className="settings-knob" />
          <span className="settings-toggle-label">{settings.enabled ? "offered" : "off"}</span>
        </label>
        <p className="settings-summary">
          {ready
            ? "Password sign-in stays available either way, so a provider that goes down cannot lock you out of your own Grimoire."
            : "Add a provider address and a client id first."}
        </p>
        {settings.linkedAccounts > 0 && (
          <p className="settings-summary">
            {settings.linkedAccounts === 1
              ? "One account signs in this way."
              : `${settings.linkedAccounts} accounts sign in this way.`}{" "}
            Each was matched by email the first time and is remembered by your provider&apos;s own
            id for them since, so it follows them if they change their address.
          </p>
        )}
      </div>
    </div>
  );
}
