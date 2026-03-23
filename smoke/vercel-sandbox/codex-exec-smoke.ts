import { Database } from "bun:sqlite";

import { allowAll, allowService, codex, sandkit } from "@giselles-ai/sandkit";
import { createBunSqliteAdapter } from "@giselles-ai/sandkit/adapters/sqlite-bun";
import { vercelSandbox } from "@giselles-ai/sandkit/integrations/vercel";

const SQLITE_PATH = process.env.SMOKE_CODEX_EXEC_DB_PATH ?? "./smoke-codex-exec.sqlite";
const SANDBOX_TIMEOUT_MS = 60_000 * 2;
const OUTPUT_PATH = "/tmp/sandkit-codex-exec-last-message.txt";
const EXPECTED_OUTPUT = "SMOKE_OK";

interface SmokeCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function hasVercelAuth(): boolean {
  return Boolean(process.env.VERCEL_OIDC_TOKEN || process.env.VERCEL_ACCESS_TOKEN);
}

function shouldSkip(): string | null {
  if (!hasVercelAuth()) {
    return "missing VERCEL_OIDC_TOKEN or VERCEL_ACCESS_TOKEN";
  }

  if (!process.env.CODEX_API_KEY) {
    return "missing CODEX_API_KEY";
  }

  return null;
}

function formatFailure(stage: string, result: SmokeCommandResult): Error {
  return new Error(
    `Smoke failed during ${stage}.\nexitCode: ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

async function runSmoke(): Promise<void> {
  const skipReason = shouldSkip();
  if (skipReason) {
    console.log("smokeCodexExec", "skipped", skipReason);
    return;
  }

  const database = new Database(SQLITE_PATH);

  try {
    const app = sandkit({
      database: createBunSqliteAdapter(database),
      sandbox: vercelSandbox({
        timeout: SANDBOX_TIMEOUT_MS,
      }),
    });

    const workspace = await app.createWorkspace({
      name: "smoke-vercel-codex-exec",
      policy: allowService(codex()),
    });

    // Bootstrap the CLI with an explicit open policy so install failures do not look like Codex firewall failures.
    const installResult = await workspace.sandbox.runCommand({
      command: "npm",
      args: ["i", "-g", "@openai/codex"],
      policy: allowAll(),
    });

    if (installResult.exitCode !== 0) {
      throw formatFailure("codex install", installResult);
    }

    const whichResult = await workspace.sandbox.runCommand({
      command: "which",
      args: ["codex"],
    });

    if (whichResult.exitCode !== 0) {
      throw formatFailure("codex path lookup", whichResult);
    }

    const codexPath = whichResult.stdout.trim();
    if (!codexPath) {
      throw new Error(
        "Smoke failed during codex path lookup. `which codex` returned an empty path.",
      );
    }

    const versionResult = await workspace.sandbox.runCommand({
      command: "codex",
      args: ["--version"],
    });

    if (versionResult.exitCode !== 0) {
      throw formatFailure("codex version check", versionResult);
    }

    const codexVersion = versionResult.stdout.trim();
    if (!codexVersion) {
      throw new Error(
        "Smoke failed during codex version check. `codex --version` returned no output.",
      );
    }

    const execResult = await workspace.sandbox.runCommand({
      command: "codex",
      args: [
        "exec",
        "--skip-git-repo-check",
        "--full-auto",
        "--color",
        "never",
        "--output-last-message",
        OUTPUT_PATH,
        `Reply with exactly ${EXPECTED_OUTPUT}`,
      ],
    });

    if (execResult.exitCode !== 0) {
      throw formatFailure("codex exec", execResult);
    }

    const outputResult = await workspace.sandbox.runCommand({
      command: "cat",
      args: [OUTPUT_PATH],
    });

    if (outputResult.exitCode !== 0) {
      throw new Error(
        `Smoke failed: could not read codex output file.\nstdout:\n${outputResult.stdout}\nstderr:\n${outputResult.stderr}`,
      );
    }

    const message = outputResult.stdout.trim();
    if (message !== EXPECTED_OUTPUT) {
      throw new Error(
        `Smoke failed: expected "${EXPECTED_OUTPUT}" from codex exec, got "${message}".`,
      );
    }

    console.log("smokeCodexExec", "ok", workspace.id, codexPath, codexVersion);
  } finally {
    database.close();
  }
}

void runSmoke();
