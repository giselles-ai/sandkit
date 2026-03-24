import { Sandbox, type NetworkPolicy } from "../packages/sandkit/node_modules/@vercel/sandbox";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function toBasicAuth(username: string, password: string): string {
  return Buffer.from(`${username}:${password}`, "utf8").toString("base64");
}

function createGitHubClonePolicy(token: string): NetworkPolicy {
  return {
    allow: {
      "github.com": [
        {
          transform: [
            {
              headers: {
                authorization: `Basic ${toBasicAuth("x-access-token", token)}`,
              },
            },
          ],
        },
      ],
    },
  };
}

function createGitHubBothPolicy(token: string): NetworkPolicy {
  return {
    allow: {
      "github.com": [
        {
          transform: [
            {
              headers: {
                authorization: `Basic ${toBasicAuth("x-access-token", token)}`,
              },
            },
          ],
        },
      ],
      "*.github.com": [
        {
          transform: [
            {
              headers: {
                authorization: `Basic ${toBasicAuth("x-access-token", token)}`,
              },
            },
          ],
        },
      ],
      "api.github.com": [
        {
          transform: [
            {
              headers: {
                authorization: `Bearer ${token}`,
              },
            },
          ],
        },
      ],
      "*.githubusercontent.com": [],
    },
  };
}

function readPolicyMode(): "clone" | "both" {
  const value = process.env.GIT_CLONE_POLICY_MODE;
  return "both";
  if (value === undefined || value === "") {
    return "clone";
  }
  if (value === "clone" || value === "both") {
    return value;
  }
  throw new Error('GIT_CLONE_POLICY_MODE must be "clone" or "both".');
}

async function main() {
  const repoUrl = requireEnv("GIT_CLONE_REPO_URL");
  const githubToken = requireEnv("GITHUB_TOKEN");
  const policyMode = readPolicyMode();

  const sandbox = await Sandbox.create({
    runtime: "node24",
    timeout: 5 * 60_000,
    networkPolicy:
      policyMode === "both"
        ? createGitHubBothPolicy(githubToken)
        : createGitHubClonePolicy(githubToken),
  });

  try {
    console.log(
      JSON.stringify(
        {
          sandboxId: sandbox.sandboxId,
          repoUrl,
          policyMode,
        },
        null,
        2,
      ),
    );

    const lsRemote = await sandbox.runCommand("git", ["ls-remote", repoUrl, "HEAD"]);
    console.log("git ls-remote exitCode:", lsRemote.exitCode);
    console.log("git ls-remote stdout:\n" + (await lsRemote.stdout()));
    console.log("git ls-remote stderr:\n" + (await lsRemote.stderr()));

    const clone = await sandbox.runCommand("sh", [
      "-lc",
      [
        "set -eu",
        "rm -rf repo",
        `git clone ${shellQuote(repoUrl)} repo`,
        "cd repo",
        "git rev-parse --is-inside-work-tree",
        "git remote -v",
        "git log -1 --oneline || true",
      ].join("\n"),
    ]);

    console.log("git clone exitCode:", clone.exitCode);
    console.log("git clone stdout:\n" + (await clone.stdout()));
    console.log("git clone stderr:\n" + (await clone.stderr()));

    if (policyMode === "both") {
      const apiCheck = await sandbox.runCommand("sh", [
        "-lc",
        ["set -eu", "curl -fsSL https://api.github.com/user"].join("\n"),
      ]);

      console.log("github api exitCode:", apiCheck.exitCode);
      console.log("github api stdout:\n" + (await apiCheck.stdout()));
      console.log("github api stderr:\n" + (await apiCheck.stderr()));
    }
  } finally {
    // await sandbox.stop().catch((error) => {
    //   console.error("Failed to stop sandbox", error);
    // });
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

await main();
