import { allowServices, github } from "@giselles-ai/sandkit";

import { requireGithubRepo, requireGithubToken } from "./lib/repo";
import { sandkit } from "./lib/sandkit";

if (import.meta.main) {
  requireGithubRepo();
  requireGithubToken();

  const workspace = await sandkit.createWorkspace({
    id: "hello-git",
    name: process.env.GITHUB_REPO,
    policy: allowServices([github()]),
  });
  console.log("workspace:", workspace.id);

  const clone = await workspace.sandbox.runCommand({
    command: "git",
    args: ["clone", `https://github.com/${process.env.GITHUB_REPO}`, "repo"],
  });
  if (clone.exitCode !== 0) {
    throw new Error(
      `Failed to clone https://github.com/${process.env.GITHUB_REPO}: ${clone.stderr}`,
    );
  }

  console.log("clone:", clone.stdout || "<no stdout>");
}
