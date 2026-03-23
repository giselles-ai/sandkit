import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { allowServices, codex, github } from "@giselles-ai/sandkit";
import { type WorkspacePolicy } from "@giselles-ai/sandkit";
import { sandkit, type PublicWorkspaceHandle } from "@giselles-ai/sandkit";
import { drizzleAdapter } from "@giselles-ai/sandkit/adapters/drizzle";
import { createVercelSandboxDriverFactory } from "@giselles-ai/sandkit/integrations/vercel";
import { createClient, type Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";

import {
  sandkitPolicies,
  sandkitRuns,
  sandkitWorkspaces,
  mergeReadinessReviews,
  mergeReadinessSessions,
} from "../db/schema";
import { createMergeReadinessStore, type MergeReadinessStore } from "./merge-readiness-store";

export const REVIEW_WORKSPACE_PREFIX = "merge-readiness";
export const SANDBOX_TIMEOUT_MS = Number.parseInt(
  process.env.MR_SANDBOX_TIMEOUT_MS ?? `${20 * 60_000}`,
  10,
);
export const MERGE_READINESS_ROOT =
  process.env.MR_WORKSPACE_ROOT ?? "/vercel/sandbox/home/merge-readiness";
export const REQ_HEADER = process.env.MR_REQUIRED_HEADER ?? "";
const REQUIRED_SCHEMA_TABLES = [
  "sandkit_workspaces",
  "sandkit_runs",
  "sandkit_policies",
  "merge_readiness_reviews",
  "merge_readiness_sessions",
  "__drizzle_migrations",
] as const;

export const MISSING_SCHEMA_HINT = `Database schema is not initialized.\nRun migration first:\n\n  bun run db:migrate\n\nIf this repository already contains a legacy data file, remove it and rerun migration:\n\n  rm -f data/merge-readiness.sqlite`;

export type MergeReadinessRuntimeConfig = {
  workspacePolicy: WorkspacePolicy;
  sandboxTimeoutMs: number;
};

export type MergeReadinessRuntime = {
  app: ReturnType<typeof sandkit>;
  store: MergeReadinessStore;
  config: MergeReadinessRuntimeConfig;
  resetWorkspaceSandboxState: (workspaceId: string) => Promise<void>;
};

function parsePositiveMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 20 * 60_000;
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

function policyForMergeReadiness(): WorkspacePolicy {
  return allowServices([github(), codex()]);
}

let runtimePromise: Promise<MergeReadinessRuntime> | null = null;

export async function getMergeReadinessRuntime(): Promise<MergeReadinessRuntime> {
  if (!runtimePromise) {
    runtimePromise = createMergeReadinessRuntime();
  }

  return runtimePromise;
}

const SOURCE_EXAMPLE_ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const CWD_EXAMPLE_ROOT_DIR = process.cwd().endsWith("/examples/merge-readiness")
  ? process.cwd()
  : join(process.cwd(), "examples", "merge-readiness");

function resolveExampleRootDir(): string {
  if (existsSync(join(CWD_EXAMPLE_ROOT_DIR, "drizzle.config.ts"))) {
    return CWD_EXAMPLE_ROOT_DIR;
  }

  return SOURCE_EXAMPLE_ROOT_DIR;
}

async function createMergeReadinessRuntime(): Promise<MergeReadinessRuntime> {
  const dbDir = join(resolveExampleRootDir(), "data");
  await mkdir(dbDir, { recursive: true });
  const dbPath = join(dbDir, "merge-readiness.sqlite");

  const sqlite = createClient({ url: `file:${dbPath}` });
  await assertSchemaInitialized(sqlite);
  const db = drizzle(sqlite, {
    schema: {
      sandkitWorkspaces,
      sandkitRuns,
      sandkitPolicies,
      mergeReadinessReviews,
      mergeReadinessSessions,
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
        timeout: parsePositiveMs(SANDBOX_TIMEOUT_MS),
        ports: [3001],
      }),
    },
  });

  return {
    app,
    store: createMergeReadinessStore(db),
    config: {
      workspacePolicy: policyForMergeReadiness(),
      sandboxTimeoutMs: parsePositiveMs(SANDBOX_TIMEOUT_MS),
    },
    resetWorkspaceSandboxState: async (workspaceId: string) => {
      const rows = await db
        .select({ metadata: sandkitWorkspaces.metadata })
        .from(sandkitWorkspaces)
        .where(eq(sandkitWorkspaces.id, workspaceId))
        .limit(1);

      const currentMetadata =
        rows[0]?.metadata && typeof rows[0].metadata === "object" ? { ...rows[0].metadata } : {};
      if ("sandkit:sandbox" in currentMetadata) {
        delete currentMetadata["sandkit:sandbox"];
      }

      await db
        .update(sandkitWorkspaces)
        .set({
          metadata: currentMetadata,
          sandboxId: null,
          lastResumedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(sandkitWorkspaces.id, workspaceId));
    },
  };
}

export function summarizeWorkspaceId(raw: string): string {
  return raw.trim().toLowerCase().replaceAll("/", "-");
}

export async function getOrCreateWorkspaceById(
  id: string,
  appHandle: MergeReadinessRuntime["app"],
): Promise<PublicWorkspaceHandle> {
  try {
    return await appHandle.getWorkspace(id);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`Workspace not found:`)) {
      return await appHandle.createWorkspace({
        id,
        name: `merge-readiness-${id}`,
        policy: policyForMergeReadiness(),
      });
    }

    throw error;
  }
}
