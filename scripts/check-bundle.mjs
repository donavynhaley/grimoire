import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

const manifest = JSON.parse(await readFile(new URL("../dist/.vite/manifest.json", import.meta.url), "utf8"));
const root = new URL("../dist/", import.meta.url);

async function measure(key) {
  const visited = new Set();
  const chunks = [];
  async function visit(id) {
    if (visited.has(id)) return;
    visited.add(id);
    const chunk = manifest[id];
    if (!chunk) throw new Error(`Missing bundle entry: ${id}`);
    chunks.push(await readFile(new URL(chunk.file, root)));
    await Promise.all((chunk.imports ?? []).map(visit));
  }
  await visit(key);
  return {
    raw: chunks.reduce((sum, bytes) => sum + bytes.length, 0),
    gzip: chunks.reduce((sum, bytes) => sum + gzipSync(bytes).length, 0),
  };
}

// Count the entire static dependency closure, so moving bytes to an eager vendor chunk cannot pass.
const budgets = [
  { key: "index.html", label: "Sign-in", raw: 240_000, gzip: 76_000 },
  { key: "src/components/Board.tsx", label: "Board", raw: 400_000, gzip: 120_000 },
];
for (const budget of budgets) {
  const actual = await measure(budget.key);
  console.log(`${budget.label}: ${actual.raw} bytes raw, ${actual.gzip} bytes gzip`);
  if (actual.raw > budget.raw || actual.gzip > budget.gzip) {
    throw new Error(`${budget.label} exceeds its ${budget.raw} raw / ${budget.gzip} gzip byte budget`);
  }
}

const boardDependencies = new Set();
function collect(key) {
  if (boardDependencies.has(key)) return;
  boardDependencies.add(key);
  for (const dependency of manifest[key].imports ?? []) collect(dependency);
}
collect("src/components/Board.tsx");
for (const name of ["PageDialog", "AccountDialog", "ProjectSettingsDialog", "MarkdownEditor"]) {
  const feature = manifest[`src/components/${name}.tsx`];
  if (!feature) throw new Error(`Missing deferred feature: ${name}`);
  if (boardDependencies.has(`src/components/${name}.tsx`)) throw new Error(`${name} is loaded eagerly`);
  for (const dependency of feature.imports ?? []) {
    if (!boardDependencies.has(dependency))
      throw new Error(`${name} has an unloaded static dependency: ${dependency}`);
  }
}
