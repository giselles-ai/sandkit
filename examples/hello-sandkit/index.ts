import { Database } from "bun:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createSandkit } from "@giselles-ai/sandkit";
import { createBunSqliteAdapter } from "@giselles-ai/sandkit/adapters/sqlite-bun";
import { vercelSandbox } from "@giselles-ai/sandkit/integrations/vercel";

const rootDir = dirname(fileURLToPath(import.meta.url));
const databasePath = resolve(rootDir, "hello-sandkit.sqlite");

if (import.meta.main) {
  const database = new Database(databasePath);

  const sandkit = createSandkit({
    database: createBunSqliteAdapter(database),
    sandbox: vercelSandbox(),
  });

  const workspace = await sandkit.createWorkspace({
    name: "hello-sandkit",
  });

  const write = await workspace.sandbox.runCommand("sh", [
    "-lc",
    "cat <<'EOF' > hello.txt\nHello from Sandkit durable runCommand.\nEOF",
  ]);
  if (write.exitCode !== 0) {
    throw new Error(`Failed to write hello.txt: ${write.stderr}`);
  }
  console.log("1st runCommand (write):", write.stdout || "<no stdout>");

  const read = await workspace.sandbox.runCommand("cat", ["hello.txt"]);
  if (read.exitCode !== 0) {
    throw new Error(`Failed to read hello.txt: ${read.stderr}`);
  }
  console.log("2nd runCommand (read):", read.stdout.trim());
}
