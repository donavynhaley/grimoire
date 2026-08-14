import { resolve } from "node:path";
import { createGrimoireServer } from "./app";
import { resolveServerPort } from "../shared/config";

const port = resolveServerPort(process.env);
const host = process.env.HOST ?? "127.0.0.1";
const production = process.env.NODE_ENV === "production";
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
  staticDirectory: production ? resolve("dist") : undefined,
});

app.server.listen(port, host, () => {
  console.log(`grimoire server listening on http://${host}:${port}`);
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
