import { resolveGithubRepo } from "./lib/repo";
import { sandkit } from "./lib/sandkit";

if (import.meta.main) {
  resolveGithubRepo();

  const workspace = await sandkit.getWorkspace("hello-git");
  console.log("workspace:", workspace.id);

  const status = await workspace.sandbox.runCommand({
    command: "git",
    args: ["-C", "repo", "status", "--short", "--branch"],
  });
  if (status.exitCode !== 0) {
    throw new Error(`Failed to inspect repo status: ${status.stderr}`);
  }
  console.log("status:", status.stdout || "<no stdout>");

  const list = await workspace.sandbox.runCommand({
    command: "ls",
    args: ["repo"],
  });
  if (list.exitCode !== 0) {
    throw new Error(`Failed to list repo directory: ${list.stderr}`);
  }
  console.log("ls:", list.stdout || "<no stdout>");
}
