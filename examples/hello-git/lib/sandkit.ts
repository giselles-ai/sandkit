import { Database } from "bun:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createSandkit } from "@giselles-ai/sandkit";
import { createBunSqliteAdapter } from "@giselles-ai/sandkit/adapters/sqlite-bun";
import { vercelSandbox } from "@giselles-ai/sandkit/integrations/vercel";

const rootDir = dirname(fileURLToPath(import.meta.url));
const databasePath = resolve(rootDir, "../hello-git.sqlite");

const database = new Database(databasePath);

export const sandkit = createSandkit({
  database: createBunSqliteAdapter(database),
  sandbox: vercelSandbox(),
});
