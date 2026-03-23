import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { sandkit } from "@giselles-ai/sandkit";
import { drizzleAdapter } from "@giselles-ai/sandkit/adapters/drizzle";
import { createVercelSandboxDriverFactory } from "@giselles-ai/sandkit/integrations/vercel";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

import {
  openclawSessions,
  sandkitPolicies,
  sandkitRuns,
  sandkitSetupStates,
  sandkitWorkspaces,
} from "../db/schema";
import { createOpenClawStore, type OpenClawStore } from "./openclaw-store";

const DEFAULT_AI_GATEWAY = "https://ai-gateway.vercel.sh/v1";
const DEFAULT_AI_MODEL = "openai/gpt-5.4-mini";
const DEFAULT_INSTALL_SPEC = "openclaw@latest";
const DEFAULT_PORT = 18_789;
const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_WORKSPACE_ID = "openclaw-production";
const SOURCE_EXAMPLE_ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const CWD_EXAMPLE_ROOT_DIR = process.cwd().endsWith("/examples/sandbox-openclaw")
  ? process.cwd()
  : join(process.cwd(), "examples", "sandbox-openclaw");
const EXAMPLE_ROOT_DIR = existsSync(join(CWD_EXAMPLE_ROOT_DIR, "drizzle.config.ts"))
  ? CWD_EXAMPLE_ROOT_DIR
  : SOURCE_EXAMPLE_ROOT_DIR;
const DATA_DIR = join(EXAMPLE_ROOT_DIR, "data");

export const WORKSPACE_ID = process.env.OPENCLAW_WORKSPACE_ID ?? DEFAULT_WORKSPACE_ID;
export const OPENCLAW_INSTALL_SPEC = process.env.OPENCLAW_INSTALL_SPEC ?? DEFAULT_INSTALL_SPEC;
export const AI_GATEWAY_API_URL = process.env.AI_GATEWAY_BASE_URL ?? DEFAULT_AI_GATEWAY;
export const AI_GATEWAY_MODEL = process.env.AI_GATEWAY_MODEL ?? DEFAULT_AI_MODEL;
export const OPENCLAW_GATEWAY_PORT = Number.parseInt(
  process.env.OPENCLAW_GATEWAY_PORT ?? `${DEFAULT_PORT}`,
  10,
);
export const SANDBOX_TIMEOUT_MS = Number.parseInt(
  process.env.SANDBOX_TIMEOUT_MS ?? `${DEFAULT_TIMEOUT_MS}`,
  10,
);
export const AI_GATEWAY_API_KEY = process.env.AI_GATEWAY_API_KEY ?? "";

const REQUIRED_SCHEMA_TABLES = [
  "sandkit_workspaces",
  "sandkit_runs",
  "sandkit_policies",
  "openclaw_sessions",
  "__drizzle_migrations",
] as const;

export const MISSING_SCHEMA_HINT = `Database schema is not initialized.\nRun migration first:\n\n  bun run db:migrate\n\nIf this repository already contains a legacy data file, remove it and rerun migration:\n\n  rm -f data/openclaw.sqlite`;

export type OpenClawRuntimeConfig = {
  workspaceId: string;
  openclawInstallSpec: string;
  aiGatewayApiUrl: string;
  aiGatewayModel: string;
  gatewayPort: number;
  sandboxTimeoutMs: number;
};

export type OpenClawRuntime = {
  app: ReturnType<typeof sandkit>;
  store: OpenClawStore;
  config: OpenClawRuntimeConfig;
};

function parsePositiveMs(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.floor(value);
}

async function assertSchemaInitialized(sqlite: Client): Promise<void> {
  const missing: string[] = [];

  try {
    for (const tableName of REQUIRED_SCHEMA_TABLES) {
      const result = await sqlite.execute({
        sql: "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1",
        args: [tableName],
      });

      if (result.rows.length === 0) {
        missing.push(tableName);
      }
    }
  } catch (error) {
    throw new Error(
      `${MISSING_SCHEMA_HINT}Underlying error:\n${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (missing.length > 0) {
    throw new Error(`${MISSING_SCHEMA_HINT}Missing tables: ${missing.join(", ")}`);
  }
}

let runtimePromise: Promise<OpenClawRuntime> | null = null;

export async function getOpenClawRuntime(): Promise<OpenClawRuntime> {
  if (!runtimePromise) {
    runtimePromise = createOpenClawRuntime();
  }

  return runtimePromise;
}

async function createOpenClawRuntime(): Promise<OpenClawRuntime> {
  if (!AI_GATEWAY_API_KEY) {
    throw new Error("AI_GATEWAY_API_KEY is required for this example.");
  }

  const dbPath = join(DATA_DIR, "openclaw.sqlite");
  await mkdir(DATA_DIR, { recursive: true });
  const sqlite = createClient({
    url: `file:${dbPath}`,
  });
  await assertSchemaInitialized(sqlite);

  const db = drizzle(sqlite, {
    schema: {
      sandkitWorkspaces,
      sandkitRuns,
      sandkitPolicies,
      openclawSessions,
      sandkitSetupStates,
    },
  });

  const adapter = drizzleAdapter(db, {
    provider: "sqlite",
  });

  const app = sandkit({
    database: adapter,
    sandbox: {
      driverFactory: createVercelSandboxDriverFactory({
        runtime: "node24",
        timeout: parsePositiveMs(SANDBOX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
        ports: [OPENCLAW_GATEWAY_PORT],
      }),
    },
  });

  return {
    app,
    store: createOpenClawStore(db),
    config: {
      workspaceId: WORKSPACE_ID,
      openclawInstallSpec: OPENCLAW_INSTALL_SPEC,
      aiGatewayApiUrl: AI_GATEWAY_API_URL,
      aiGatewayModel: AI_GATEWAY_MODEL,
      gatewayPort: OPENCLAW_GATEWAY_PORT,
      sandboxTimeoutMs: parsePositiveMs(SANDBOX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    },
  };
}
