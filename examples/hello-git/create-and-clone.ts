import { allowServices, github } from "@giselles-ai/sandkit";

import { requireGithubToken, resolveGithubRepo } from "./lib/repo";
import { sandkit } from "./lib/sandkit";

if (import.meta.main) {
  const repo = resolveGithubRepo();
  requireGithubToken();

  const workspace = await sandkit.createWorkspace({
    id: "hello-git",
    name: repo,
    policy: allowServices([github()]),
  });
  console.log("workspace:", workspace.id);

  const clone = await workspace.sandbox.runCommand({
    command: "git",
    args: ["clone", `https://github.com/${repo}`, "repo"],
  });
  if (clone.exitCode !== 0) {
    throw new Error(
      `Failed to clone https://github.com/${repo}: ${clone.stderr}`,
    );
  }

  console.log("clone:", clone.stdout || "<no stdout>");
}
