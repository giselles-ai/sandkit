import { Database } from "bun:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createSandkit, allowServices, github } from "@giselles-ai/sandkit";
import { createBunSqliteAdapter } from "@giselles-ai/sandkit/adapters/sqlite-bun";
import { vercelSandbox } from "@giselles-ai/sandkit/integrations/vercel";

const rootDir = dirname(fileURLToPath(import.meta.url));
const databasePath = resolve(rootDir, "hello-git.sqlite");

function requireEnvVar(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}. Set ${name} and run again.`);
  }
  return value;
}

function isGithubRepo(value: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

if (import.meta.main) {
  const githubRepo = requireEnvVar("GITHUB_REPO");
  requireEnvVar("GITHUB_TOKEN");

  if (!isGithubRepo(githubRepo)) {
    throw new Error("GITHUB_REPO must be in `org/name` format.");
  }

  const database = new Database(databasePath);
  const sandkit = createSandkit({
    database: createBunSqliteAdapter(database),
    sandbox: vercelSandbox(),
  });

  const workspace = await sandkit.createWorkspace({
    name: "hello-git",
    policy: allowServices([github()]),
  });

  const clone = await workspace.sandbox.runCommand({
    command: "git",
    args: ["clone", `https://github.com/${githubRepo}`, "repo"],
  });
  if (clone.exitCode !== 0) {
    throw new Error(`Failed to clone https://github.com/${githubRepo}: ${clone.stderr}`);
  }
  console.log("clone:", clone.stdout || "<no stdout>");

  const list = await workspace.sandbox.runCommand({
    command: "ls",
    args: ["repo"],
  });
  if (list.exitCode !== 0) {
    throw new Error(`Failed to list repo directory: ${list.stderr}`);
  }
  console.log("ls:", list.stdout || "<no stdout>");
}
