import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import {
  sandkit,
  createVercelSandboxDriverFactory,
  type PublicWorkspaceHandle,
  type Sandkit,
} from "sandkit";
import { drizzleAdapter } from "sandkit/adapters/drizzle";

import { sandkitPolicies, sandkitRuns, sandkitWorkspaces } from "./schema";

export type OpenClawState = {
  hasWorkspace: boolean;
  workspaceId?: string;
  hasActiveSession: boolean;
  sandboxId?: string;
  openclawUrl?: string;
  remainingMs?: number;
  expiresAt?: string;
  connectCommand?: string;
};

type ApiAction = "createWorkspace" | "startSession" | "extendSession" | "commitSession";

const HOME_DIR = "/vercel/sandbox/home";
const NPM_PREFIX = "/vercel/sandbox/npm-global";
const OPENCLAW_CONFIG_DIR = `${HOME_DIR}/.openclaw`;
const OPENCLAW_AGENT_DIR = `${HOME_DIR}/.openclaw-agent`;
const OPENCLAW_LAUNCHER_PATH = `${OPENCLAW_CONFIG_DIR}/start-openclaw-gateway.sh`;
const OPENCLAW_CONFIG_PATH = `${OPENCLAW_CONFIG_DIR}/openclaw.json`;
const OPENCLAW_LOG_PATH = `${OPENCLAW_CONFIG_DIR}/gateway.log`;
const NODE_BIN_DIR = "/vercel/runtimes/node24/bin";
const DEFAULT_AI_GATEWAY = "https://ai-gateway.vercel.sh/v1";
const DEFAULT_AI_MODEL = "openai/gpt-5.4-mini";
const DEFAULT_INSTALL_SPEC = "openclaw@latest";
const DEFAULT_PORT = 18_789;
const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_WORKSPACE_ID = "openclaw-production";
const CONTROL_UI_BOOTSTRAP_PATH = "/__openclaw/control-ui-config.json";

const sqlCreateWorkspaces = `CREATE TABLE IF NOT EXISTS sandkit_workspaces (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT,
  metadata TEXT,
  status TEXT NOT NULL,
  sandboxId TEXT,
  lastResumedAt TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
)`;

const sqlCreatePolicies = `CREATE TABLE IF NOT EXISTS sandkit_policies (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  config TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id) REFERENCES sandkit_workspaces(id)
)`;

const sqlCreateRuns = `CREATE TABLE IF NOT EXISTS sandkit_runs (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  execution_target_id TEXT NOT NULL,
  command TEXT NOT NULL,
  args TEXT,
  status TEXT NOT NULL,
  policy_snapshot_id TEXT,
  provider_commit TEXT,
  exit_code INTEGER,
  stdout TEXT,
  stderr TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  FOREIGN KEY(workspace_id) REFERENCES sandkit_workspaces(id),
  FOREIGN KEY(policy_snapshot_id) REFERENCES sandkit_policies(id)
)`;

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

function buildSandboxReadyCommand(sandboxUrl: string): string {
  return `${sandboxUrl}${CONTROL_UI_BOOTSTRAP_PATH}`;
}

function buildOpenClawConfig(authToken: string, uiOrigin: string): string {
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
          allowedOrigins: [uiOrigin],
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

function controlUiOrigin(url: string): string {
  return new URL(url).origin;
}

async function initializeSchema(database: Client): Promise<void> {
  await database.execute(sqlCreateWorkspaces);
  await database.execute(sqlCreatePolicies);
  await database.execute(sqlCreateRuns);
}

async function withRetry<T>(action: () => Promise<T>, attempts = 6, baseMs = 500): Promise<T> {
  for (let index = 1; index <= attempts; index += 1) {
    try {
      return await action();
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
    async () => {
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

async function waitForSessionUrl(
  session: Awaited<ReturnType<PublicWorkspaceHandle["sandbox"]["attachSession"]>>,
): Promise<string> {
  return withRetry(
    async () => {
      return session.url(OPENCLAW_GATEWAY_PORT);
    },
    20,
    700,
  );
}

async function writeOpenClawConfigForSession(
  session: Awaited<ReturnType<PublicWorkspaceHandle["sandbox"]["attachSession"]>>,
  uiUrl: string,
): Promise<void> {
  const tokenResult = await session.exec("bash", [
    "-lc",
    `cat '${OPENCLAW_CONFIG_DIR}/auth-token.txt' 2>/dev/null || true`,
  ]);
  const authToken = tokenResult.stdout.trim() || randomToken();
  const openclawConfig = buildOpenClawConfig(authToken, controlUiOrigin(uiUrl));
  const encodedConfig = Buffer.from(openclawConfig).toString("base64");

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
}

async function sessionConfigAllowsOrigin(
  session: Awaited<ReturnType<PublicWorkspaceHandle["sandbox"]["attachSession"]>>,
  uiUrl: string,
): Promise<boolean> {
  const result = await session.exec("bash", [
    "-lc",
    `cat '${OPENCLAW_CONFIG_PATH}' 2>/dev/null || true`,
  ]);
  return result.stdout.includes(controlUiOrigin(uiUrl));
}

async function stopGateway(
  session: Awaited<ReturnType<PublicWorkspaceHandle["sandbox"]["attachSession"]>>,
): Promise<void> {
  await session.exec("bash", [
    "-lc",
    "pkill -f 'openclaw-gateway|openclaw.mjs gateway run|start-openclaw-gateway.sh' || true",
  ]);
}

async function readBootstrapStatusWithCommand(workspace: PublicWorkspaceHandle): Promise<boolean> {
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

async function probeLocalGateway(
  session: Awaited<ReturnType<PublicWorkspaceHandle["sandbox"]["attachSession"]>>,
): Promise<void> {
  await withRetry(
    async () => {
      const result = await session.exec("bash", [
        "-lc",
        [
          "set -euo pipefail",
          "tmp_headers=$(mktemp)",
          "tmp_body=$(mktemp)",
          `curl -sS -D "$tmp_headers" -o "$tmp_body" 'http://127.0.0.1:${OPENCLAW_GATEWAY_PORT}${CONTROL_UI_BOOTSTRAP_PATH}'`,
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

async function isLocalGatewayReady(
  session: Awaited<ReturnType<PublicWorkspaceHandle["sandbox"]["attachSession"]>>,
): Promise<boolean> {
  try {
    const result = await session.exec("bash", [
      "-lc",
      `curl -sS -o /tmp/openclaw-ready.out 'http://127.0.0.1:${OPENCLAW_GATEWAY_PORT}${CONTROL_UI_BOOTSTRAP_PATH}' && test -s /tmp/openclaw-ready.out`,
    ]);
    return result.exitCode === 0;
  } catch {
    return false;
  }
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

async function writeLauncherScriptInSession(
  session: Awaited<ReturnType<PublicWorkspaceHandle["sandbox"]["attachSession"]>>,
): Promise<void> {
  const encodedToken = Buffer.from(buildLauncherScript()).toString("base64");
  await runCheckedInSession(
    session,
    "bash",
    [
      "-lc",
      `printf '%s' '${encodedToken}' | base64 -d > '${OPENCLAW_LAUNCHER_PATH}'
chmod +x '${OPENCLAW_LAUNCHER_PATH}'`,
    ],
    "write OpenClaw launcher script",
  );
}

async function ensureWorkspaceBootstrapped(workspace: PublicWorkspaceHandle): Promise<void> {
  if (await readBootstrapStatusWithCommand(workspace)) {
    return;
  }

  await bootstrapOpenClawInWorkspace(workspace);
}

async function ensureSessionBootstrapped(
  session: Awaited<ReturnType<PublicWorkspaceHandle["sandbox"]["attachSession"]>>,
): Promise<void> {
  const isBootstrapped = await readBootstrapStatusWithSession(session);
  await writeLauncherScriptInSession(session);
  if (isBootstrapped) {
    return;
  }

  const authTokenResult = await session.exec("bash", [
    "-lc",
    `cat '${OPENCLAW_CONFIG_DIR}/auth-token.txt' 2>/dev/null || true`,
  ]);
  const authToken = authTokenResult.stdout.trim() || randomToken();
  const openclawConfig = buildOpenClawConfig(authToken, "http://127.0.0.1");
  const encodedConfig = Buffer.from(openclawConfig).toString("base64");
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

function randomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function ensureGatewayRunning(workspace: PublicWorkspaceHandle): Promise<string> {
  const existingLease = await workspace.sandbox.getActiveLease();
  const session = existingLease
    ? await workspace.sandbox.attachSession()
    : (await ensureWorkspaceBootstrapped(workspace), await workspace.sandbox.openSession());

  await ensureSessionBootstrapped(session);

  const url = await waitForSessionUrl(session);
  const hasAllowedOrigin = await sessionConfigAllowsOrigin(session, url);
  if (!hasAllowedOrigin) {
    await writeOpenClawConfigForSession(session, url);
    await stopGateway(session);
  }

  if (!hasAllowedOrigin || !(await isLocalGatewayReady(session))) {
    const command = await session.startProcess("bash", ["-lc", OPENCLAW_LAUNCHER_PATH]);
    void command.wait().catch(() => {
      /* readiness and diagnostics handle startup failures. */
    });

    try {
      await probeLocalGateway(session);
    } catch (error) {
      const diagnostics = await collectGatewayDiagnostics(session);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        [message, diagnostics ? `Gateway diagnostics:\n${diagnostics}` : ""]
          .filter(Boolean)
          .join("\n\n"),
      );
    }
  }

  await waitForOpenClawReady(url);
  return url;
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

  const dbPath = join(process.cwd(), "data", "openclaw.sqlite");
  await mkdir(join(process.cwd(), "data"), { recursive: true });
  const sqlite = createClient({
    url: `file:${dbPath}`,
  });
  await initializeSchema(sqlite);

  const db = drizzle(sqlite, {
    schema: {
      sandkitWorkspaces,
      sandkitRuns,
      sandkitPolicies,
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

    const workspaceState = await extractActiveSessionInfo(workspace);
    if (workspaceState) {
      return {
        hasWorkspace: true,
        workspaceId: workspace.id,
        ...workspaceState,
      };
    }

    return {
      hasWorkspace: true,
      workspaceId: workspace.id,
      hasActiveSession: false,
    };
  }

  async function createWorkspace(): Promise<OpenClawState> {
    const existing = await loadWorkspace();
    if (existing) {
      throw new Error("Workspace already exists.");
    }

    const workspace = await runtime.createWorkspace({ id: WORKSPACE_ID, name: "openclaw-demo" });
    await bootstrapOpenClawInWorkspace(workspace);
    return getState();
  }

  async function startSession(): Promise<OpenClawState> {
    const workspace = await workspaceOrThrow();
    await ensureGatewayRunning(workspace);
    return getState();
  }

  async function extendSession(durationMs: number): Promise<OpenClawState> {
    const workspace = await workspaceOrThrow();
    const safeDuration = parsePositiveInteger(durationMs, 10 * 60_000);

    await withActiveSession(workspace, async (session) => {
      await session.extendTimeout(safeDuration);
    });

    return getState();
  }

  async function commitSession(): Promise<OpenClawState> {
    const workspace = await workspaceOrThrow();
    await withActiveSession(workspace, async (session) => {
      await session.commit();
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
