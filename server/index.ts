import { resolve } from "node:path";
import { resolveServerPort } from "../shared/config";
import { createGrimoireServer } from "./app";
import { oidcConfigFromEnvironment } from "./oidc";

const port = resolveServerPort(process.env);
const host = process.env.HOST ?? "127.0.0.1";
const production = process.env.NODE_ENV === "production";
// A misconfigured provider stops the process rather than starting without its sign-in button,
// because a missing button looks exactly like a provider that is merely slow to appear.
const oidc = oidcConfigFromEnvironment(process.env);
const app = createGrimoireServer({
  // The root is a storage location the operator chooses rather than product vocabulary, so
  // its default stays where existing installs already keep their files - repointing a live
  // instance at a new empty path would look exactly like losing the project.
  // GRIMOIRE_PAGES_DIRECTORY is the name going forward; the older one is still honoured so a
  // deployed .env and both compose files keep working untouched.
  pagesDirectory: resolve(
    process.env.GRIMOIRE_PAGES_DIRECTORY ?? process.env.GRIMOIRE_CARDS_DIRECTORY ?? "data/cards",
  ),
  databasePath: resolve(process.env.GRIMOIRE_DATABASE ?? "data/grimoire.sqlite"),
  production,
  demoAnalyticsToken: process.env.GRIMOIRE_DEMO_ANALYTICS_TOKEN,
  staticDirectory: production ? resolve("dist") : undefined,
  oidc,
  // Whether a reverse proxy or tunnel in front of Grimoire is writing the forwarded headers.
  // It decides whose sign-in attempts are counted together, so it is asked rather than guessed.
  trustProxy: /^(1|true|yes)$/i.test(process.env.GRIMOIRE_TRUST_PROXY ?? ""),
});

app.server.listen(port, host, () => {
  console.log(`grimoire server listening on http://${host}:${port}`);
  if (oidc) console.log(`grimoire single sign-on enabled via ${oidc.issuer}`);
});

function shutdown() {
  app.closeEventStreams();
  app.server.close(() => {
    app.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
