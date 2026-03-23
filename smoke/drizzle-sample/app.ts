import { Database } from "bun:sqlite";
import { pathToFileURL } from "node:url";

import { drizzle } from "drizzle-orm/bun-sqlite";
import { drizzleAdapter } from "sandkit/adapters/drizzle";
import { sandkit } from "sandkit";

const SQLITE_PATH = process.env.SMOKE_DRIZZLE_SAMPLE_DB_PATH ?? "./smoke-drizzle-workspaces.sqlite";
const SCHEMA_PATH = "./generated/sandkit-schema.generated.ts";

async function run(): Promise<void> {
  const db = new Database(SQLITE_PATH);
  const moduleUrl = pathToFileURL(SCHEMA_PATH).href;
  const schemaModule = await import(moduleUrl);
  const schema = schemaModule.sandkitSchema ?? schemaModule.default?.sandkitSchema;
  if (!schema) {
    throw new Error("Smoke drizzle sample: generated schema missing sandkitSchema export");
  }

  const drizzleDb = drizzle(db, { schema });
  const app = sandkit({
    database: drizzleAdapter(drizzleDb, {
      provider: "sqlite",
    }),
  });

  const created = await app.createWorkspace({
    name: "smoke-drizzle-sample",
  });
  const reloaded = await app.getWorkspace(created.id);
  console.log(`workspace=${reloaded.id} name=${reloaded.descriptor.name}`);
  db.close();
}

void run();
