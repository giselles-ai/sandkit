import { Database } from "bun:sqlite";
import { rm } from "node:fs/promises";

import { createSandkit, allowService, codex, gemini, github } from "@giselles-ai/sandkit";
import { createMemoryAdapter } from "@giselles-ai/sandkit/adapters/memory";
import { createBunSqliteAdapter } from "@giselles-ai/sandkit/adapters/sqlite-bun";
import { mockSandbox } from "@giselles-ai/sandkit/integrations/mock";
// Internal-seam smoke: policy compile is intentionally validated via package internals.

import { compileVercelNetworkPolicy } from "./internal-seams.ts";

function readAuthorizationHeader(
  policy: ReturnType<typeof compileVercelNetworkPolicy>,
  domain: string,
) {
  if (typeof policy === "string" || !policy.allow || Array.isArray(policy.allow)) {
    throw new Error("Smoke failed: expected Vercel record-form allow policy");
  }

  const rules = policy.allow[domain];
  const header = rules?.[0]?.transform?.[0]?.headers?.authorization;
  if (!header) {
    throw new Error(`Smoke failed: expected authorization header for ${domain}`);
  }

  return header;
}

async function expectFailure(label: string, operation: () => Promise<unknown>, expected: string) {
  try {
    await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(expected)) {
      throw new Error(`${label} failed with unexpected message: ${message}`);
    }
    return;
  }

  throw new Error(`${label} did not fail`);
}

function expectSyncFailure(label: string, operation: () => unknown, expected: string) {
  try {
    operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(expected)) {
      throw new Error(`${label} failed with unexpected message: ${message}`);
    }
    return;
  }

  throw new Error(`${label} did not fail`);
}

async function runSmoke(): Promise<void> {
  process.env.CODEX_API_KEY = "env-secret";
  const envCompiled = compileVercelNetworkPolicy(allowService(codex()));
  if (readAuthorizationHeader(envCompiled, "api.openai.com") !== "Bearer env-secret") {
    throw new Error("Smoke failed: expected CODEX_API_KEY to compile into authorization header");
  }

  const explicitCompiled = compileVercelNetworkPolicy(
    allowService(codex({ apiKey: "explicit-secret" })),
  );
  if (readAuthorizationHeader(explicitCompiled, "api.openai.com") !== "Bearer explicit-secret") {
    throw new Error("Smoke failed: expected explicit apiKey to compile into authorization header");
  }

  delete process.env.CODEX_API_KEY;
  await expectFailure(
    "missing env credential",
    async () => {
      compileVercelNetworkPolicy(allowService(codex()));
    },
    "requires CODEX_API_KEY",
  );

  expectSyncFailure(
    "codex empty override",
    () => codex({ apiKey: undefined }),
    'codex(...) explicit override requires a non-empty "apiKey"',
  );
  expectSyncFailure(
    "gemini empty override",
    () => gemini({}),
    'gemini(...) explicit override requires a non-empty "apiKey"',
  );
  expectSyncFailure(
    "github empty override",
    () => github({ apiKey: "   " }),
    'github(...) explicit override requires a non-empty "apiKey"',
  );

  const sandkit = createSandkit({
    database: createMemoryAdapter(),
    sandbox: mockSandbox(),
  });
  await expectFailure(
    "createWorkspace with explicit secret policy",
    () =>
      sandkit.createWorkspace({
        name: "reject-secret-default",
        policy: allowService(codex({ apiKey: "top-secret" })),
      }),
    "cannot be stored durably",
  );

  const workspace = await sandkit.createWorkspace({ name: "reject-secret-set-policy" });
  await expectFailure(
    "setPolicy with explicit secret policy",
    () => workspace.setPolicy(allowService(codex({ apiKey: "top-secret" }))),
    "cannot be stored durably",
  );

  const sqlitePath = "./smoke-policy-credentials.sqlite";
  await rm(sqlitePath, { force: true });
  const sqlite = new Database(sqlitePath);

  try {
    const sqliteSandkit = createSandkit({
      database: createBunSqliteAdapter(sqlite),
      sandbox: mockSandbox(),
    });
    const sqliteWorkspace = await sqliteSandkit.createWorkspace({ name: "redact-per-run-secret" });

    await sqliteWorkspace.sandbox.runCommand({
      command: "policy-id",
      policy: allowService(codex({ apiKey: "run-secret" })),
    });

    const policyRow = sqlite
      .query<{ config: string }, [string]>(
        "SELECT config FROM sandkit_policies WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(sqliteWorkspace.id);

    if (!policyRow) {
      throw new Error("Smoke failed: expected a persisted policy snapshot for per-run override");
    }

    if (policyRow.config.includes("run-secret")) {
      throw new Error("Smoke failed: persisted policy snapshot leaked explicit secret value");
    }

    const persistedConfig = JSON.parse(policyRow.config) as {
      mode?: string;
      services?: Array<{
        headers?: Array<{
          credential?: {
            kind?: string;
            value?: string;
          };
        }>;
      }>;
    };

    const credential = persistedConfig.services?.[0]?.headers?.[0]?.credential;
    if (persistedConfig.mode !== "allow-services" || credential?.kind !== "redacted") {
      throw new Error("Smoke failed: expected persisted per-run credential to be redacted");
    }

    if ("value" in (credential ?? {})) {
      throw new Error("Smoke failed: redacted persisted credential must not retain value");
    }
  } finally {
    sqlite.close();
    await rm(sqlitePath, { force: true });
  }

  console.log("smokePolicyCredentials", "ok");
}

void runSmoke();
