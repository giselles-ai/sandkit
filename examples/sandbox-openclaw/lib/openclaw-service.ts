import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient, type Client } from "@libsql/client";
import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import {
  sandkit,
  createVercelSandboxDriverFactory,
  type PublicWorkspaceHandle,
  type Sandkit,
} from "sandkit";
import { drizzleAdapter } from "sandkit/adapters/drizzle";

import { openclawSessions, sandkitPolicies, sandkitRuns, sandkitWorkspaces } from "../db/schema";

export type OpenClawState = {
  hasWorkspace: boolean;
  workspaceId?: string;
  hasActiveSession: boolean;
  openclawPhase?: OpenClawPublicPhase;
  sandboxId?: string;
  openclawUrl?: string;
  remainingMs?: number;
  expiresAt?: string;
  connectCommand?: string;
};

type OpenClawSessionRecordPhase =
  | "bootstrapping"
  | "bootstrapped"
  | "session_started"
  | "server_starting"
  | "ready"
  | "degraded"
  | "repairing"
  | "failed";

type OpenClawPublicPhase = "bootstrapped" | "session_started" | "server_started" | "ready";

const DURABLE_OPENCLAW_BOOTSTRAP_PHASES: readonly OpenClawSessionRecordPhase[] = [
  "bootstrapped",
  "ready",
] as const;

const RESUMABLE_OPENCLAW_SESSION_PHASES: readonly OpenClawSessionRecordPhase[] = [
  "bootstrapped",
  "degraded",
  "repairing",
  "ready",
  "session_started",
  "server_starting",
] as const;

type OpenClawMetadataSummary = {
  version: number;
  phase: OpenClawPublicPhase;
  activeSessionId: string | null;
  lastErrorAt: string | null;
  bootstrapVersion: number | null;
};

type WorkspaceMetadata = {
  openclaw?: OpenClawMetadataSummary;
  [key: string]: unknown;
};

type OpenClawSessionRecord = typeof openclawSessions.$inferSelect;
type OpenClawSessionInsert = typeof openclawSessions.$inferInsert;

type ApiAction = "createWorkspace" | "startSession" | "extendSession" | "commitSession";

const HOME_DIR = "/vercel/sandbox/home";
const NPM_PREFIX = "/vercel/sandbox/npm-global";
const OPENCLAW_CONFIG_DIR = `${HOME_DIR}/.openclaw`;
const OPENCLAW_AGENT_DIR = `${HOME_DIR}/.openclaw-agent`;
const OPENCLAW_LAUNCHER_PATH = `${OPENCLAW_CONFIG_DIR}/start-openclaw-gateway.sh`;
const OPENCLAW_CONFIG_PATH = `${OPENCLAW_CONFIG_DIR}/openclaw.json`;
const OPENCLAW_LOG_PATH = `${OPENCLAW_CONFIG_DIR}/gateway.log`;
const NODE_BIN_DIR = "/vercel/runtimes/node24/bin";
const OPENCLAW_SESSION_SCHEMA_VERSION = 1;
const DEFAULT_AI_GATEWAY = "https://ai-gateway.vercel.sh/v1";
const DEFAULT_AI_MODEL = "openai/gpt-5.4-mini";
const DEFAULT_INSTALL_SPEC = "openclaw@latest";
const DEFAULT_PORT = 18_789;
const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_WORKSPACE_ID = "openclaw-production";
const CONTROL_UI_BOOTSTRAP_PATH = "/__openclaw/control-ui-config.json";
const EXAMPLE_ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(EXAMPLE_ROOT_DIR, "data");

const WORKSPACE_ID = process.env.OPENCLAW_WORKSPACE_ID ?? DEFAULT_WORKSPACE_ID;
const OPENCLAW_INSTALL_SPEC = process.env.OPENCLAW_INSTALL_SPEC ?? DEFAULT_INSTALL_SPEC;
const AI_GATEWAY_API_URL = process.env.AI_GATEWAY_BASE_URL ?? DEFAULT_AI_GATEWAY;
const AI_GATEWAY_MODEL = process.env.AI_GATEWAY_MODEL ?? DEFAULT_AI_MODEL;
const OPENCLAW_GATEWAY_PORT = Number.parseInt(
  process.env.OPENCLAW_GATEWAY_PORT ?? `${DEFAULT_PORT}`,
  10,
);
const SANDBOX_TIMEOUT_MS = Number.parseInt(
  process.env.SANDBOX_TIMEOUT_MS ?? `${DEFAULT_TIMEOUT_MS}`,
  10,
);
const gatewayApiKey = process.env.AI_GATEWAY_API_KEY ?? "";

type Runtime = {
  readonly workspace: () => Promise<PublicWorkspaceHandle | null>;
  readonly getState: () => Promise<OpenClawState>;
  readonly createWorkspace: () => Promise<OpenClawState>;
  readonly startSession: () => Promise<OpenClawState>;
  readonly extendSession: (durationMs: number) => Promise<OpenClawState>;
  readonly commitSession: () => Promise<OpenClawState>;
};

let runtimePromise: Promise<Runtime> | null = null;

function parsePositiveMs(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.floor(value);
}

function parsePositiveInteger(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    return fallback;
  }

  return value;
}

function formatDurationMs(ms: number): number {
  const parsed = Number.parseInt(`${ms}`, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }

  return parsed;
}

function isWorkspaceMetadata(value: unknown): value is WorkspaceMetadata {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOpenClawSessionRecordPhase(value: unknown): value is OpenClawSessionRecordPhase {
  return (
    value === "bootstrapping" ||
    value === "bootstrapped" ||
    value === "session_started" ||
    value === "server_starting" ||
    value === "ready" ||
    value === "degraded" ||
    value === "repairing" ||
    value === "failed"
  );
}

function isOpenClawPublicPhase(value: unknown): value is OpenClawPublicPhase {
  return (
    value === "bootstrapped" ||
    value === "session_started" ||
    value === "server_started" ||
    value === "ready"
  );
}

function isOpenClawMetadataSummary(value: unknown): value is OpenClawMetadataSummary {
  if (!isWorkspaceMetadata(value)) {
    return false;
  }

  const metadata = value as Record<string, unknown>;
  const version = metadata.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version <= 0) {
    return false;
  }

  const phase = metadata.phase;
  if (!isOpenClawPublicPhase(phase)) {
    return false;
  }

  const activeSessionId = metadata.activeSessionId;
  if (typeof activeSessionId !== "string" && activeSessionId !== null) {
    return false;
  }

  const lastErrorAt = metadata.lastErrorAt;
  if (typeof lastErrorAt !== "string" && lastErrorAt !== null) {
    return false;
  }

  const bootstrapVersion = metadata.bootstrapVersion;
  if (typeof bootstrapVersion !== "number" && bootstrapVersion !== null) {
    return false;
  }

  return true;
}

function normalizeOpenClawMetadataSummary(
  value: WorkspaceMetadata["openclaw"],
): OpenClawMetadataSummary {
  if (isOpenClawMetadataSummary(value)) {
    return value;
  }

  return {
    version: OPENCLAW_SESSION_SCHEMA_VERSION,
    phase: "bootstrapped",
    activeSessionId: null,
    lastErrorAt: null,
    bootstrapVersion: null,
  };
}

function parseWorkspaceMetadata(raw: unknown): WorkspaceMetadata {
  if (!raw) {
    return {};
  }

  let parsed = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      return {};
    }

    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(
        `Workspace metadata is corrupted: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (!isWorkspaceMetadata(parsed)) {
    throw new Error("Workspace metadata is corrupted: expected a JSON object.");
  }

  return parsed;
}

export function deriveOpenClawPhaseForPassiveRead(
  activeState: Pick<OpenClawState, "hasActiveSession" | "openclawUrl"> | null,
  hasDurableBootstrap: boolean,
  inProgressPublicPhase: OpenClawPublicPhase | undefined,
): OpenClawPublicPhase | undefined {
  if (activeState?.hasActiveSession) {
    if (activeState.openclawUrl) {
      return "ready";
    }

    if (
      (inProgressPublicPhase === "session_started" || inProgressPublicPhase === "server_started") &&
      hasDurableBootstrap
    ) {
      return inProgressPublicPhase;
    }

    if (hasDurableBootstrap) {
      return "bootstrapped";
    }
  }

  return hasDurableBootstrap ? "bootstrapped" : undefined;
}

export function composeOpenClawPassiveState(
  workspaceState: Pick<
    OpenClawState,
    | "hasActiveSession"
    | "sandboxId"
    | "openclawUrl"
    | "remainingMs"
    | "expiresAt"
    | "connectCommand"
  > | null,
  hasDurableBootstrap: boolean,
  inProgressPublicPhase?: OpenClawPublicPhase,
): Pick<
  OpenClawState,
  | "openclawPhase"
  | "hasActiveSession"
  | "sandboxId"
  | "openclawUrl"
  | "remainingMs"
  | "expiresAt"
  | "connectCommand"
> {
  const openclawPhase = deriveOpenClawPhaseForPassiveRead(
    workspaceState,
    hasDurableBootstrap,
    inProgressPublicPhase,
  );

  if (!workspaceState) {
    return {
      hasActiveSession: false,
      openclawPhase,
    };
  }

  return {
    hasActiveSession: workspaceState.hasActiveSession,
    openclawPhase,
    sandboxId: workspaceState.sandboxId,
    openclawUrl: workspaceState.openclawUrl,
    remainingMs: workspaceState.remainingMs,
    expiresAt: workspaceState.expiresAt,
    connectCommand: workspaceState.connectCommand,
  };
}

export function isOpenClawSessionRecordReusableForStart(
  session: Pick<OpenClawSessionRecord, "phase" | "finished_at">,
): boolean {
  if (session.finished_at !== null) {
    return false;
  }

  return (
    isOpenClawSessionRecordPhase(session.phase) &&
    RESUMABLE_OPENCLAW_SESSION_PHASES.includes(session.phase)
  );
}

function makeSummary(
  workspaceMetadata: WorkspaceMetadata,
  phase: OpenClawPublicPhase,
  activeSessionId: string | null,
  lastErrorAt: string | null,
): WorkspaceMetadata {
  return {
    ...workspaceMetadata,
    openclaw: {
      version: OPENCLAW_SESSION_SCHEMA_VERSION,
      phase,
      activeSessionId,
      lastErrorAt,
      bootstrapVersion: 1,
    },
  };
}

const MISSING_SCHEMA_HINT = `Database schema is not initialized.
Run migration first:

  bun run db:migrate

If this repository already contains a legacy data file, remove it and rerun migration:

  rm -f data/openclaw.sqlite
`;

const REQUIRED_SCHEMA_TABLES = [
  "sandkit_workspaces",
  "sandkit_runs",
  "sandkit_policies",
  "openclaw_sessions",
  "__drizzle_migrations",
] as const;

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

function buildSandboxReadyCommand(sandboxUrl: string): string {
  return `${sandboxUrl}${CONTROL_UI_BOOTSTRAP_PATH}`;
}

function buildOpenClawConfig(authToken: string, controlUiOrigin: string): string {
  const modelRef = `sandbox-gateway/${AI_GATEWAY_MODEL}`;
  const controlUiRoot = `${NPM_PREFIX}/lib/node_modules/openclaw/dist/control-ui`;

  return JSON.stringify(
    {
      agents: {
        defaults: {
          model: {
            primary: modelRef,
          },
          models: {
            [modelRef]: {
              alias: "Vercel Sandbox Gateway",
            },
          },
        },
      },
      gateway: {
        mode: "local",
        bind: "lan",
        port: OPENCLAW_GATEWAY_PORT,
        controlUi: {
          enabled: true,
          root: controlUiRoot,
          allowedOrigins: [controlUiOrigin],
          dangerouslyDisableDeviceAuth: true,
        },
        auth: {
          mode: "token",
          token: authToken,
        },
      },
      models: {
        mode: "merge",
        providers: {
          "sandbox-gateway": {
            baseUrl: AI_GATEWAY_API_URL,
            apiKey: gatewayApiKey,
            authHeader: true,
            api: "openai-completions",
            models: [
              {
                id: AI_GATEWAY_MODEL,
                name: AI_GATEWAY_MODEL,
                reasoning: false,
                input: ["text"],
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                contextWindow: 131072,
                maxTokens: 4096,
              },
            ],
          },
        },
      },
    },
    null,
    2,
  );
}

async function withRetry<T>(
  action: (attempt: number) => Promise<T>,
  attempts = 6,
  baseMs = 500,
): Promise<T> {
  for (let index = 1; index <= attempts; index += 1) {
    try {
      return await action(index);
    } catch (error) {
      if (index === attempts) {
        throw error;
      }

      const delayMs = baseMs * index;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error("Retry loop did not complete.");
}

async function waitForOpenClawReady(url: string): Promise<void> {
  const readyUrl = buildSandboxReadyCommand(url);

  await withRetry(
    async (attempt) => {
      console.info("[openclaw] waitForOpenClawReady attempt", {
        attempt,
        url: readyUrl,
      });
      const response = await fetch(readyUrl, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`OpenClaw not ready: status ${response.status}`);
      }

      const text = await response.text();
      if (!text.trim()) {
        throw new Error("OpenClaw readiness payload empty.");
      }
    },
    20,
    700,
  );
}

async function isOpenClawReady(url: string): Promise<boolean> {
  try {
    const response = await fetch(buildSandboxReadyCommand(url), { cache: "no-store" });
    if (!response.ok) {
      return false;
    }

    const text = await response.text();
    return text.trim().length > 0;
  } catch {
    return false;
  }
}

async function waitForSessionUrl(
  session: Awaited<ReturnType<PublicWorkspaceHandle["sandbox"]["attachSession"]>>,
): Promise<string> {
  return withRetry(
    async (attempt) => {
      console.info("[openclaw] waitForSessionUrl attempt", {
        attempt,
        port: OPENCLAW_GATEWAY_PORT,
      });
      return session.url(OPENCLAW_GATEWAY_PORT);
    },
    20,
    700,
  );
}

async function readBootstrapStatusWithSession(
  session: Awaited<ReturnType<PublicWorkspaceHandle["sandbox"]["attachSession"]>>,
): Promise<boolean> {
  const result = await session.exec("bash", [
    "-lc",
    [
      `test -x '${NPM_PREFIX}/bin/openclaw'`,
      `test -f '${OPENCLAW_CONFIG_PATH}'`,
      `test -x '${OPENCLAW_LAUNCHER_PATH}'`,
    ].join("\n"),
  ]);

  return result.exitCode === 0;
}

async function readBootstrapStatusInWorkspace(workspace: PublicWorkspaceHandle): Promise<boolean> {
  const result = await workspace.sandbox.runCommand("bash", [
    "-lc",
    [
      `test -x '${NPM_PREFIX}/bin/openclaw'`,
      `test -f '${OPENCLAW_CONFIG_PATH}'`,
      `test -x '${OPENCLAW_LAUNCHER_PATH}'`,
    ].join("\n"),
  ]);

  return result.exitCode === 0;
}

async function probeLocalGateway(
  session: Awaited<ReturnType<PublicWorkspaceHandle["sandbox"]["attachSession"]>>,
): Promise<void> {
  await withRetry(
    async (attempt) => {
      console.info("[openclaw] probeLocalGateway attempt", {
        attempt,
        port: OPENCLAW_GATEWAY_PORT,
      });
      const result = await session.exec("bash", [
        "-lc",
        [
          "set -euo pipefail",
          "tmp_headers=$(mktemp)",
          "tmp_body=$(mktemp)",
          `curl --connect-timeout 2 --max-time 4 -sS -D "$tmp_headers" -o "$tmp_body" 'http://127.0.0.1:${OPENCLAW_GATEWAY_PORT}${CONTROL_UI_BOOTSTRAP_PATH}'`,
          'body=$(cat "$tmp_body")',
          'if [ -z "$body" ]; then',
          "  echo 'local gateway returned empty payload' >&2",
          "  sed -n '1,20p' \"$tmp_headers\" >&2 || true",
          "  exit 1",
          "fi",
          "printf '%s' \"$body\"",
        ].join("\n"),
      ]);

      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || "OpenClaw localhost probe failed.");
      }
    },
    20,
    700,
  );
}

async function stopGatewayProcess(
  session: Awaited<ReturnType<PublicWorkspaceHandle["sandbox"]["attachSession"]>>,
): Promise<void> {
  await session.exec("bash", [
    "-lc",
    [
      "set -euo pipefail",
      `pkill -f "${NPM_PREFIX}/bin/openclaw gateway run" || true`,
      `pkill -f "${OPENCLAW_LAUNCHER_PATH}" || true`,
    ].join("\n"),
  ]);
}

async function collectGatewayDiagnostics(
  session: Awaited<ReturnType<PublicWorkspaceHandle["sandbox"]["attachSession"]>>,
): Promise<string> {
  try {
    const result = await session.exec("bash", [
      "-lc",
      [
        "set -euo pipefail",
        "printf '%s\\n' '---PROCESS---'",
        "ps -ef | grep openclaw | grep -v grep || true",
        "printf '%s\\n' '---FILES---'",
        `ls -l '${NPM_PREFIX}/bin/openclaw' '${OPENCLAW_CONFIG_PATH}' '${OPENCLAW_LAUNCHER_PATH}' 2>&1 || true`,
        "printf '%s\\n' '---LOG---'",
        `tail -n 120 '${OPENCLAW_LOG_PATH}' 2>&1 || true`,
      ].join("\n"),
    ]);

    return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function sandboxOriginFromUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    throw new Error(`OpenClaw session URL is not parseable: ${url}`);
  }
}

async function updateControlUiConfigForSession(
  session: Awaited<ReturnType<PublicWorkspaceHandle["sandbox"]["attachSession"]>>,
  sandboxUrl: string,
): Promise<void> {
  const tokenResult = await session.exec("bash", [
    "-lc",
    `cat '${OPENCLAW_CONFIG_DIR}/auth-token.txt'`,
  ]);
  const authToken = tokenResult.stdout.trim();
  const controlUiOrigin = sandboxOriginFromUrl(sandboxUrl);
  const encodedConfig = Buffer.from(buildOpenClawConfig(authToken, controlUiOrigin)).toString(
    "base64",
  );

  await session.exec("bash", [
    "-lc",
    `printf '%s' '${encodedConfig}' | base64 -d > '${OPENCLAW_CONFIG_PATH}'`,
  ]);
}

async function runCheckedInSession(
  session: Awaited<ReturnType<PublicWorkspaceHandle["sandbox"]["attachSession"]>>,
  command: string,
  args: string[],
  label: string,
) {
  const result = await session.exec(command, args);
  if (result.exitCode !== 0) {
    const message = `${label} failed with exitCode ${result.exitCode}:
STDOUT:
${result.stdout}
STDERR:
${result.stderr}`;
    throw new Error(message);
  }
}

async function runChecked(
  workspace: PublicWorkspaceHandle,
  command: string,
  args: string[],
  label: string,
) {
  const result = await workspace.sandbox.runCommand(command, args);
  if (result.exitCode !== 0) {
    const message = `${label} failed with exitCode ${result.exitCode}:
STDOUT:
${result.stdout}
STDERR:
${result.stderr}`;
    throw new Error(message);
  }
}

function buildLauncherScript(): string {
  return `#!/usr/bin/env bash
set -euo pipefail
export HOME='${HOME_DIR}'
export OPENCLAW_AGENT_DIR='${OPENCLAW_AGENT_DIR}'
export OPENCLAW_CONFIG_PATH='${OPENCLAW_CONFIG_PATH}'
export PATH='${NODE_BIN_DIR}:${NPM_PREFIX}/bin:/usr/local/bin:/usr/bin:/bin'

: > '${OPENCLAW_LOG_PATH}'
exec '${NPM_PREFIX}/bin/openclaw' gateway run --port ${OPENCLAW_GATEWAY_PORT} >> '${OPENCLAW_LOG_PATH}' 2>&1
`;
}

async function bootstrapOpenClawInWorkspace(workspace: PublicWorkspaceHandle): Promise<void> {
  const authToken = randomToken();
  const openclawConfig = buildOpenClawConfig(authToken, "http://127.0.0.1");
  const encodedConfig = Buffer.from(openclawConfig).toString("base64");
  const encodedToken = Buffer.from(buildLauncherScript()).toString("base64");

  await runChecked(
    workspace,
    "bash",
    ["-lc", `mkdir -p '${OPENCLAW_CONFIG_DIR}' '${OPENCLAW_AGENT_DIR}' '${NPM_PREFIX}'`],
    "prepare sandbox directories",
  );

  await runChecked(workspace, "bash", ["-lc", "which npm || true"], "verify npm availability");

  await runChecked(
    workspace,
    "npm",
    ["install", "-g", "--prefix", NPM_PREFIX, OPENCLAW_INSTALL_SPEC],
    "install OpenClaw CLI",
  );

  await runChecked(
    workspace,
    "bash",
    [
      "-lc",
      `printf '%s' '${encodedConfig}' | base64 -d > '${OPENCLAW_CONFIG_PATH}'
printf '%s' '${authToken}' > '${OPENCLAW_CONFIG_DIR}/auth-token.txt'`,
    ],
    "write OpenClaw config",
  );

  await runChecked(
    workspace,
    "bash",
    [
      "-lc",
      `printf '%s' '${encodedToken}' | base64 -d > '${OPENCLAW_LAUNCHER_PATH}'
chmod +x '${OPENCLAW_LAUNCHER_PATH}'`,
    ],
    "write OpenClaw launcher script",
  );
}

async function repairOpenClawInSession(
  session: Awaited<ReturnType<PublicWorkspaceHandle["sandbox"]["attachSession"]>>,
): Promise<void> {
  const authToken = randomToken();
  const openclawConfig = buildOpenClawConfig(authToken, "http://127.0.0.1");
  const encodedConfig = Buffer.from(openclawConfig).toString("base64");
  const encodedLauncher = Buffer.from(buildLauncherScript()).toString("base64");

  await runCheckedInSession(
    session,
    "bash",
    ["-lc", `mkdir -p '${OPENCLAW_CONFIG_DIR}' '${OPENCLAW_AGENT_DIR}' '${NPM_PREFIX}'`],
    "prepare sandbox directories",
  );

  await runCheckedInSession(
    session,
    "npm",
    ["install", "-g", "--prefix", NPM_PREFIX, OPENCLAW_INSTALL_SPEC],
    "install OpenClaw CLI",
  );

  await runCheckedInSession(
    session,
    "bash",
    [
      "-lc",
      `printf '%s' '${encodedConfig}' | base64 -d > '${OPENCLAW_CONFIG_PATH}'
printf '%s' '${authToken}' > '${OPENCLAW_CONFIG_DIR}/auth-token.txt'`,
    ],
    "write OpenClaw config",
  );

  await runCheckedInSession(
    session,
    "bash",
    [
      "-lc",
      `printf '%s' '${encodedLauncher}' | base64 -d > '${OPENCLAW_LAUNCHER_PATH}'
chmod +x '${OPENCLAW_LAUNCHER_PATH}'`,
    ],
    "write OpenClaw launcher script",
  );
}

function randomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

type OpenClawSessionUpdate = {
  phase?: OpenClawSessionRecordPhase;
  sandbox_id?: string | null;
  public_url?: string | null;
  last_healthy_at?: Date | null;
  error_code?: string | null;
  error_message?: string | null;
  updated_at?: Date;
  finished_at?: Date | null;
};

type UpdateOpenClawSessionRecord = (
  sessionId: string,
  update: OpenClawSessionUpdate,
) => Promise<void>;

function createProcessOutputCapture(label: string, maxChars = 8_000) {
  let stdout = "";
  let stderr = "";

  const trim = (value: string) => value.slice(-maxChars);

  return {
    onStdout(chunk: string) {
      stdout = trim(`${stdout}${chunk}`);
      console.info(`[openclaw] ${label} stdout`, chunk);
    },
    onStderr(chunk: string) {
      stderr = trim(`${stderr}${chunk}`);
      console.error(`[openclaw] ${label} stderr`, chunk);
    },
    snapshot() {
      return {
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      };
    },
  };
}

function logTimedStepStart(step: string, context: Record<string, unknown> = {}) {
  const startedAt = Date.now();
  console.info(`[openclaw] ${step} start`, {
    startedAt: new Date(startedAt).toISOString(),
    ...context,
  });

  return {
    success(extra: Record<string, unknown> = {}) {
      console.info(`[openclaw] ${step} success`, {
        finishedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        ...context,
        ...extra,
      });
    },
    failure(error: unknown, extra: Record<string, unknown> = {}) {
      console.error(`[openclaw] ${step} failure`, {
        finishedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        ...context,
        ...extra,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  };
}

async function ensureGatewayRunning(
  workspace: PublicWorkspaceHandle,
  openclawSession: OpenClawSessionRecord,
  updateSession: UpdateOpenClawSessionRecord,
  isRepair: boolean,
  onProgress?: (phase: OpenClawPublicPhase) => Promise<void>,
): Promise<{
  url: string;
  lease: NonNullable<Awaited<ReturnType<PublicWorkspaceHandle["sandbox"]["getActiveLease"]>>>;
}> {
  const ensureStep = logTimedStepStart("ensureGatewayRunning", {
    workspaceId: workspace.id,
    openclawSessionId: openclawSession.id,
  });
  const sessionResolutionStep = logTimedStepStart("resolveSandboxSession", {
    workspaceId: workspace.id,
    openclawSessionId: openclawSession.id,
  });
  const existingLease = await workspace.sandbox.getActiveLease();
  const attachedExisting = Boolean(existingLease);
  const activeSession = existingLease
    ? await workspace.sandbox.attachSession()
    : await workspace.sandbox.openSession();
  sessionResolutionStep.success({
    attachedExisting,
    sandboxId: existingLease?.sandboxId ?? null,
  });

  const sessionUrlStep = logTimedStepStart("waitForSessionUrl", {
    workspaceId: workspace.id,
    openclawSessionId: openclawSession.id,
  });
  const url = await waitForSessionUrl(activeSession);
  sessionUrlStep.success({ url });
  const bootstrapStatusStep = logTimedStepStart("readBootstrapStatus", {
    workspaceId: workspace.id,
    openclawSessionId: openclawSession.id,
  });
  let bootstrapReady = await readBootstrapStatusWithSession(activeSession);
  bootstrapStatusStep.success({ bootstrapReady });
  if (!bootstrapReady) {
    const bootstrapRepairStep = logTimedStepStart("bootstrapRepair", {
      workspaceId: workspace.id,
      openclawSessionId: openclawSession.id,
      phase: "repairing",
      isRepair,
    });
    if (!isRepair) {
      bootstrapRepairStep.failure(
        new Error("OpenClaw bootstrap artifacts are missing and startup is not in repair mode."),
      );
      await updateSession(openclawSession.id, {
        phase: "failed",
        error_code: "bootstrap_missing",
        error_message:
          "OpenClaw bootstrap artifacts are missing and this start request is not a repair path.",
        updated_at: new Date(),
      });
      throw new Error("OpenClaw bootstrap artifacts are missing from the session.");
    }

    await updateSession(openclawSession.id, {
      phase: "repairing",
      error_code: "bootstrap_missing",
      error_message: "OpenClaw bootstrap artifacts missing; attempting repair.",
      updated_at: new Date(),
    });
    await repairOpenClawInSession(activeSession);
    bootstrapReady = await readBootstrapStatusWithSession(activeSession);
    bootstrapRepairStep.success({ bootstrapReady });
  }

  if (!bootstrapReady) {
    const finalBootstrapFailureStep = logTimedStepStart("bootstrapMissingFailure", {
      workspaceId: workspace.id,
      openclawSessionId: openclawSession.id,
    });
    await updateSession(openclawSession.id, {
      phase: "failed",
      error_code: "bootstrap_missing",
      error_message: "OpenClaw bootstrap artifacts still missing after repair.",
      updated_at: new Date(),
    });
    finalBootstrapFailureStep.failure(
      new Error("Bootstrap artifacts are still missing after repair."),
    );
    throw new Error("OpenClaw bootstrap artifacts are missing from the workspace.");
  }

  const controlUiConfigStep = logTimedStepStart("updateControlUiConfig", {
    workspaceId: workspace.id,
    openclawSessionId: openclawSession.id,
    url,
  });
  await updateControlUiConfigForSession(activeSession, url);
  controlUiConfigStep.success();

  const restartGatewayFromUnhealthyState = async () => {
    const restartStartStep = logTimedStepStart("restartGatewayFromUnhealthyState", {
      workspaceId: workspace.id,
      openclawSessionId: openclawSession.id,
      phase: "server_starting",
    });
    await updateSession(openclawSession.id, {
      phase: "server_starting",
      error_code: null,
      error_message: null,
      updated_at: new Date(),
    });
    await stopGatewayProcess(activeSession);
    const gatewayProcessOutput = createProcessOutputCapture(
      `gateway bootstrap ${openclawSession.id}`,
    );
    const startGatewayStep = logTimedStepStart("startGatewayProcess", {
      workspaceId: workspace.id,
      openclawSessionId: openclawSession.id,
      url,
    });
    const command = await activeSession.startProcess({
      command: "bash",
      args: ["-lc", OPENCLAW_LAUNCHER_PATH],
      onStdout: (chunk) => {
        gatewayProcessOutput.onStdout(chunk);
      },
      onStderr: (chunk) => {
        gatewayProcessOutput.onStderr(chunk);
      },
    });
    startGatewayStep.success({ processId: command.processId });
    void command.wait().catch(() => {
      /* readiness and diagnostics handle startup failures. */
    });

    try {
      const restartedProbeStep = logTimedStepStart("probeLocalGateway", {
        workspaceId: workspace.id,
        openclawSessionId: openclawSession.id,
        phase: "server_starting",
        attempt: "restarted",
      });
      await probeLocalGateway(activeSession);
      restartedProbeStep.success();
      restartStartStep.success();
      return;
    } catch (error) {
      const diagnostics = await collectGatewayDiagnostics(activeSession);
      const processOutput = gatewayProcessOutput.snapshot();
      const message = error instanceof Error ? error.message : String(error);
      await updateSession(openclawSession.id, {
        phase: "failed",
        error_code: "gateway_start_failed",
        error_message: "Gateway failed to become healthy.",
        updated_at: new Date(),
      });
      restartStartStep.failure(error);
      throw new Error(
        [
          message,
          processOutput.stdout ? `Gateway startup stdout:\n${processOutput.stdout}` : "",
          processOutput.stderr ? `Gateway startup stderr:\n${processOutput.stderr}` : "",
          diagnostics ? `Gateway diagnostics:\n${diagnostics}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
    }
  };

  try {
    if (onProgress) {
      await onProgress("server_started");
    }
    if (!isRepair && attachedExisting) {
      const localProbeStep = logTimedStepStart("probeLocalGateway", {
        workspaceId: workspace.id,
        openclawSessionId: openclawSession.id,
        phase: "server_starting",
        attempt: "initial",
      });
      await updateSession(openclawSession.id, {
        phase: "server_starting",
        error_code: null,
        error_message: null,
        updated_at: new Date(),
      });
      await probeLocalGateway(activeSession);
      localProbeStep.success();
    } else {
      console.info("[openclaw] skipping initial localhost probe", {
        workspaceId: workspace.id,
        openclawSessionId: openclawSession.id,
        isRepair,
        attachedExisting,
      });
      await restartGatewayFromUnhealthyState();
    }
  } catch {
    await restartGatewayFromUnhealthyState();
  }

  const publicReadyStep = logTimedStepStart("waitForOpenClawReady", {
    workspaceId: workspace.id,
    openclawSessionId: openclawSession.id,
    url,
  });
  await waitForOpenClawReady(url);
  publicReadyStep.success();
  const lease = await workspace.sandbox.getActiveLease();
  await updateSession(openclawSession.id, {
    phase: "ready",
    public_url: url,
    sandbox_id: lease?.sandboxId ?? null,
    last_healthy_at: new Date(),
    error_code: null,
    error_message: null,
    updated_at: new Date(),
  });

  if (!lease) {
    throw new Error("Active lease disappeared before OpenClaw startup completed.");
  }

  ensureStep.success({ url, sandboxId: lease.sandboxId });
  return { url, lease };
}

async function readSessionToken(
  session: Awaited<ReturnType<PublicWorkspaceHandle["sandbox"]["attachSession"]>>,
): Promise<string> {
  try {
    const tokenResult = await session.exec("bash", [
      "-lc",
      `cat '${OPENCLAW_CONFIG_DIR}/auth-token.txt'`,
    ]);
    return tokenResult.stdout.trim();
  } catch {
    return "";
  }
}

async function createOrLoadWorkspace(app: Sandkit): Promise<PublicWorkspaceHandle | null> {
  try {
    return await app.getWorkspace(WORKSPACE_ID);
  } catch {
    return null;
  }
}

async function createRuntime(): Promise<Runtime> {
  if (!gatewayApiKey) {
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
    },
  });

  const adapter = drizzleAdapter(db, {
    provider: "sqlite",
  });

  const runtime = sandkit({
    database: adapter,
    sandbox: {
      driverFactory: createVercelSandboxDriverFactory({
        runtime: "node24",
        timeout: parsePositiveMs(SANDBOX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
        ports: [OPENCLAW_GATEWAY_PORT],
      }),
    },
  });

  function nowDate(): Date {
    return new Date();
  }

  async function loadWorkspaceMetadata(workspaceId: string): Promise<WorkspaceMetadata> {
    const rows = await db
      .select({ metadata: sandkitWorkspaces.metadata })
      .from(sandkitWorkspaces)
      .where(eq(sandkitWorkspaces.id, workspaceId))
      .limit(1);

    if (rows.length === 0) {
      return {};
    }

    return parseWorkspaceMetadata(rows[0].metadata);
  }

  async function loadOpenClawSummary(workspaceId: string): Promise<OpenClawMetadataSummary> {
    const metadata = await loadWorkspaceMetadata(workspaceId);
    return normalizeOpenClawMetadataSummary(metadata.openclaw);
  }

  async function updateOpenClawSummary(
    workspaceId: string,
    update: Partial<OpenClawMetadataSummary>,
  ): Promise<void> {
    const metadata = await loadWorkspaceMetadata(workspaceId);
    const current = normalizeOpenClawMetadataSummary(metadata.openclaw);
    const nextSummary = makeSummary(
      metadata,
      update.phase ?? current.phase,
      update.activeSessionId ?? metadata.openclaw?.activeSessionId ?? null,
      update.lastErrorAt === undefined
        ? (metadata.openclaw?.lastErrorAt ?? null)
        : update.lastErrorAt,
    );

    if (update.phase !== undefined) {
      nextSummary.phase = update.phase;
    }
    if (update.activeSessionId !== undefined) {
      nextSummary.activeSessionId = update.activeSessionId;
    }
    if (update.bootstrapVersion !== undefined) {
      nextSummary.bootstrapVersion = update.bootstrapVersion;
    }
    if (update.lastErrorAt !== undefined) {
      nextSummary.lastErrorAt = update.lastErrorAt;
    }

    await db
      .update(sandkitWorkspaces)
      .set({
        metadata: nextSummary,
      })
      .where(eq(sandkitWorkspaces.id, workspaceId));
  }

  async function updateOpenClawSessionRecord(
    sessionId: string,
    update: OpenClawSessionUpdate,
  ): Promise<void> {
    await db
      .update(openclawSessions)
      .set({
        ...update,
        updated_at: update.updated_at ?? nowDate(),
      })
      .where(eq(openclawSessions.id, sessionId));
  }

  async function createOpenClawSession(
    workspaceId: string,
    phase: OpenClawSessionRecordPhase,
  ): Promise<OpenClawSessionRecord> {
    const now = nowDate();
    const sessionId = randomToken();
    const values: OpenClawSessionInsert = {
      id: sessionId,
      workspace_id: workspaceId,
      sandbox_id: null,
      phase,
      install_spec: OPENCLAW_INSTALL_SPEC,
      public_url: null,
      last_healthy_at: null,
      error_code: null,
      error_message: null,
      started_at: now,
      updated_at: now,
      finished_at: null,
    };

    await db.insert(openclawSessions).values(values);

    const rows = await db
      .select()
      .from(openclawSessions)
      .where(eq(openclawSessions.id, sessionId))
      .limit(1);
    if (!rows[0]) {
      throw new Error("Failed to create OpenClaw session record.");
    }

    return rows[0];
  }

  async function getOpenClawSessionById(sessionId: string): Promise<OpenClawSessionRecord | null> {
    const rows = await db
      .select()
      .from(openclawSessions)
      .where(eq(openclawSessions.id, sessionId))
      .limit(1);

    return rows[0] ?? null;
  }

  async function getLatestOpenClawSession(
    workspaceId: string,
  ): Promise<OpenClawSessionRecord | null> {
    const rows = await db
      .select()
      .from(openclawSessions)
      .where(eq(openclawSessions.workspace_id, workspaceId))
      .orderBy(desc(openclawSessions.started_at), desc(openclawSessions.id))
      .limit(1);

    return rows[0] ?? null;
  }

  async function getLatestUnfinishedSession(
    workspaceId: string,
  ): Promise<OpenClawSessionRecord | null> {
    const rows = await db
      .select()
      .from(openclawSessions)
      .where(eq(openclawSessions.workspace_id, workspaceId))
      .orderBy(desc(openclawSessions.started_at), desc(openclawSessions.id))
      .limit(10);

    for (const row of rows) {
      if (row.finished_at === null) {
        return row;
      }
    }

    return null;
  }

  async function hasDurableOpenClawBootstrap(workspaceId: string): Promise<boolean> {
    const rows = await db
      .select({ phase: openclawSessions.phase })
      .from(openclawSessions)
      .where(eq(openclawSessions.workspace_id, workspaceId))
      .orderBy(desc(openclawSessions.started_at), desc(openclawSessions.id))
      .limit(10);

    return rows.some(({ phase }) => {
      if (!isOpenClawSessionRecordPhase(phase)) {
        return false;
      }

      return DURABLE_OPENCLAW_BOOTSTRAP_PHASES.includes(phase);
    });
  }

  async function getOrCreateActiveSession(workspaceId: string): Promise<OpenClawSessionRecord> {
    const latest = await getLatestOpenClawSession(workspaceId);
    if (!latest) {
      return createOpenClawSession(workspaceId, "bootstrapping");
    }

    if (latest.phase === "bootstrapping") {
      await updateOpenClawSessionRecord(latest.id, {
        phase: "failed",
        error_code: "stale_bootstrap",
        error_message: "Previous bootstrap session was incomplete.",
        updated_at: nowDate(),
      });
    }

    if (isOpenClawSessionRecordReusableForStart(latest)) {
      return latest;
    }

    return createOpenClawSession(workspaceId, "bootstrapping");
  }

  async function bootstrapSessionRecord(session: OpenClawSessionRecord): Promise<boolean> {
    const workspace = await workspaceOrThrow();
    await bootstrapOpenClawInWorkspace(workspace);
    const bootstrapReady = await readBootstrapStatusInWorkspace(workspace);

    if (!bootstrapReady) {
      await updateOpenClawSessionRecord(session.id, {
        phase: "failed",
        error_code: "bootstrap_failed",
        error_message: "OpenClaw bootstrap artifacts missing after install.",
        updated_at: nowDate(),
      });
      return false;
    }

    await updateOpenClawSessionRecord(session.id, {
      phase: "bootstrapped",
      error_code: null,
      error_message: null,
      updated_at: nowDate(),
    });
    return true;
  }

  function isErrorCapable(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async function markSessionFailure(
    workspaceId: string,
    session: OpenClawSessionRecord,
    reason: string,
  ): Promise<void> {
    const timestamp = nowDate();
    const message = isErrorCapable(reason);
    await updateOpenClawSessionRecord(session.id, {
      phase: "failed",
      error_code: "transition_failed",
      error_message: message,
      finished_at: timestamp,
      updated_at: timestamp,
    });
    await updateOpenClawSummary(workspaceId, {
      phase: "bootstrapped",
      activeSessionId: session.id,
      lastErrorAt: timestamp.toISOString(),
    });
    throw new Error(message);
  }

  async function loadWorkspace(): Promise<PublicWorkspaceHandle | null> {
    const workspace = await createOrLoadWorkspace(runtime);
    return workspace ? workspace : null;
  }

  async function workspaceOrThrow(): Promise<PublicWorkspaceHandle> {
    const workspace = await loadWorkspace();
    if (!workspace) {
      throw new Error("Workspace does not exist.");
    }
    return workspace;
  }

  async function extractActiveSessionInfo(
    workspace: PublicWorkspaceHandle,
  ): Promise<Pick<
    OpenClawState,
    | "hasActiveSession"
    | "sandboxId"
    | "openclawUrl"
    | "remainingMs"
    | "expiresAt"
    | "connectCommand"
  > | null> {
    const lease = await workspace.sandbox.getActiveLease();
    if (!lease) {
      return null;
    }

    const baseState: Pick<
      OpenClawState,
      "hasActiveSession" | "sandboxId" | "remainingMs" | "expiresAt" | "connectCommand"
    > = {
      hasActiveSession: true,
      sandboxId: lease.sandboxId,
      remainingMs: lease.remainingMs,
      expiresAt: lease.expiresAt,
      connectCommand: `sandbox connect ${lease.sandboxId}`,
    };

    try {
      const session = await workspace.sandbox.attachSession();
      const openclawUrl = await waitForSessionUrl(session);
      if (!(await isOpenClawReady(openclawUrl))) {
        return baseState;
      }

      const token = await readSessionToken(session);
      const uiUrl = token ? `${openclawUrl}#token=${encodeURIComponent(token)}` : openclawUrl;
      return {
        ...baseState,
        openclawUrl: uiUrl,
      };
    } catch {
      return baseState;
    }
  }

  async function withActiveSession<T>(
    workspace: PublicWorkspaceHandle,
    action: (session: Awaited<ReturnType<typeof workspace.sandbox.attachSession>>) => Promise<T>,
  ): Promise<T> {
    const session = await workspace.sandbox.attachSession();
    return action(session);
  }

  async function getState(): Promise<OpenClawState> {
    const workspace = await loadWorkspace();
    if (!workspace) {
      return {
        hasWorkspace: false,
        hasActiveSession: false,
      };
    }

    const hasDurableBootstrap = await hasDurableOpenClawBootstrap(workspace.id);
    const workspaceState = await extractActiveSessionInfo(workspace);
    const workspaceSummary = await loadOpenClawSummary(workspace.id);
    const passiveState = composeOpenClawPassiveState(
      workspaceState,
      hasDurableBootstrap,
      workspaceSummary.phase,
    );

    return {
      hasWorkspace: true,
      workspaceId: workspace.id,
      ...passiveState,
    };
  }

  async function createWorkspace(): Promise<OpenClawState> {
    const existing = await loadWorkspace();
    if (existing) {
      throw new Error("Workspace already exists.");
    }

    const workspace = await runtime.createWorkspace({ id: WORKSPACE_ID, name: "openclaw-demo" });
    const session = await createOpenClawSession(workspace.id, "bootstrapping");
    await updateOpenClawSummary(workspace.id, {
      phase: "bootstrapped",
      activeSessionId: session.id,
      lastErrorAt: null,
    });
    const bootstrapped = await bootstrapSessionRecord(session);
    if (!bootstrapped) {
      await markSessionFailure(
        workspace.id,
        session,
        "OpenClaw bootstrap artifacts missing after initial bootstrap.",
      );
    }
    await updateOpenClawSummary(workspace.id, {
      phase: "bootstrapped",
      activeSessionId: session.id,
      lastErrorAt: null,
    });
    return getState();
  }

  async function startSession(): Promise<OpenClawState> {
    const startSessionStep = logTimedStepStart("startSession", {});
    const workspace = await workspaceOrThrow();
    let session = await getOrCreateActiveSession(workspace.id);
    const activeSessionState = await extractActiveSessionInfo(workspace);
    const isRepair = Boolean(
      activeSessionState?.hasActiveSession && !activeSessionState.openclawUrl,
    );
    const nextStartPhase = "session_started";

    await updateOpenClawSessionRecord(session.id, {
      phase: nextStartPhase,
      updated_at: new Date(),
    });
    await updateOpenClawSummary(workspace.id, {
      phase: nextStartPhase,
      activeSessionId: session.id,
      lastErrorAt: null,
    });
    let startupResult:
      | {
          url: string;
          lease: NonNullable<
            Awaited<ReturnType<PublicWorkspaceHandle["sandbox"]["getActiveLease"]>>
          >;
        }
      | undefined;
    let didFail = false;

    try {
      startupResult = await ensureGatewayRunning(
        workspace,
        session,
        updateOpenClawSessionRecord,
        isRepair,
        async (phase) => {
          await updateOpenClawSummary(workspace.id, {
            phase,
            activeSessionId: session.id,
            lastErrorAt: null,
        });
      },
    );
      const isReady = await isOpenClawReady(startupResult.url);
      if (!isReady) {
        didFail = true;
        await markSessionFailure(
          workspace.id,
          session,
          "OpenClaw UI is not publicly reachable after startup.",
        );
      } else {
        await updateOpenClawSummary(workspace.id, {
          phase: "ready",
          activeSessionId: session.id,
          lastErrorAt: null,
        });
      }
    } catch (error) {
      didFail = true;
      startSessionStep.failure(error, {
        workspaceId: workspace.id,
        openclawSessionId: session.id,
      });
      await markSessionFailure(
        workspace.id,
        session,
        `Failed to start OpenClaw session: ${isErrorCapable(error)}`,
      );
    }

    let nextState: OpenClawState;
    if (!didFail && startupResult) {
      const token = await readSessionToken(await workspace.sandbox.attachSession());
      nextState = {
        hasWorkspace: true,
        workspaceId: workspace.id,
        hasActiveSession: true,
        openclawPhase: "ready",
        sandboxId: startupResult.lease.sandboxId,
        remainingMs: startupResult.lease.remainingMs,
        expiresAt: startupResult.lease.expiresAt,
        connectCommand: `sandbox connect ${startupResult.lease.sandboxId}`,
        openclawUrl: token
          ? `${startupResult.url}#token=${encodeURIComponent(token)}`
          : startupResult.url,
      };
    } else {
      const getStateStep = logTimedStepStart("startSession.getState", {
        workspaceId: workspace.id,
        openclawSessionId: session.id,
      });
      nextState = await getState();
      getStateStep.success({
        hasActiveSession: nextState.hasActiveSession,
        sandboxId: nextState.sandboxId ?? null,
        openclawUrl: nextState.openclawUrl ?? null,
      });
    }

    startSessionStep.success({
      workspaceId: workspace.id,
      openclawSessionId: session.id,
      hasActiveSession: nextState.hasActiveSession,
      sandboxId: nextState.sandboxId ?? null,
    });
    return nextState;
  }

  async function extendSession(durationMs: number): Promise<OpenClawState> {
    const workspace = await workspaceOrThrow();
    const safeDuration = parsePositiveInteger(durationMs, 10 * 60_000);

    await withActiveSession(workspace, async (session) => {
      await session.extendTimeout(safeDuration);
    });
    await updateOpenClawSummary(workspace.id, {
      phase: "ready",
      activeSessionId: (await loadOpenClawSummary(workspace.id)).activeSessionId,
      lastErrorAt: null,
    });

    return getState();
  }

  async function commitSession(): Promise<OpenClawState> {
    const workspace = await workspaceOrThrow();
    const summary = await loadOpenClawSummary(workspace.id);
    const lease = await workspace.sandbox.getActiveLease();

    if (!lease) {
      throw new Error("No active session to commit.");
    }

    const resolvedSession = summary.activeSessionId
      ? await getOpenClawSessionById(summary.activeSessionId)
      : null;
    const activeSession = resolvedSession ?? (await getLatestUnfinishedSession(workspace.id));

    if (!activeSession) {
      throw new Error("No active OpenClaw session exists to commit.");
    }

    await withActiveSession(workspace, async (session) => {
      await session.commit();
    });

    const finishAt = nowDate();
    await updateOpenClawSessionRecord(activeSession.id, {
      finished_at: finishAt,
      updated_at: finishAt,
    });
    await updateOpenClawSummary(workspace.id, {
      phase: "bootstrapped",
      activeSessionId: null,
      lastErrorAt: null,
    });

    return getState();
  }

  return {
    workspace: loadWorkspace,
    getState,
    createWorkspace,
    startSession,
    extendSession,
    commitSession,
  };
}

export async function getRuntime(): Promise<Runtime> {
  if (!runtimePromise) {
    runtimePromise = createRuntime();
  }

  return runtimePromise;
}

export async function readState(): Promise<OpenClawState> {
  const runtime = await getRuntime();
  return runtime.getState();
}

export async function performAction(
  action: ApiAction,
  durationMs?: number,
): Promise<OpenClawState> {
  const runtime = await getRuntime();

  switch (action) {
    case "createWorkspace":
      return runtime.createWorkspace();
    case "startSession":
      return runtime.startSession();
    case "extendSession":
      return runtime.extendSession(formatDurationMs(durationMs ?? 10 * 60_000));
    case "commitSession":
      return runtime.commitSession();
    default:
      throw new Error(`Unsupported action: ${action}`);
  }
}
