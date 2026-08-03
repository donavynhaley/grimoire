import { resolve } from "node:path";
import { createGrimoireServer } from "./app";

const port = Number(process.env.PORT ?? 5175);
const host = process.env.HOST ?? "127.0.0.1";
const production = process.env.NODE_ENV === "production";
const app = createGrimoireServer({
  databasePath: resolve(process.env.GRIMOIRE_DATABASE ?? "data/grimoire.sqlite"),
  production,
  staticDirectory: production ? resolve("dist") : undefined,
});

app.server.listen(port, host, () => {
  console.log(`grimoire server listening on http://${host}:${port}`);
});

function shutdown() {
  app.server.close(() => {
    app.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

