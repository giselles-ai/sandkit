import { rm } from "node:fs/promises";

await Promise.all([
  rm("drizzle", { recursive: true, force: true }),
  rm("smoke-drizzle-workspaces.sqlite", { force: true }),
]);
