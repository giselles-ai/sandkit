import type { PublicWorkspaceHandle } from "sandkit";

import {
  type OpenClawSessionRecord,
  type OpenClawSessionUpdate,
  isOpenClawPublicPhase,
} from "./openclaw-store";

const HOME_DIR = "/vercel/sandbox/home";
const NPM_PREFIX = "/vercel/sandbox/npm-global";
const OPENCLAW_CONFIG_DIR = `${HOME_DIR}/.openclaw`;
const OPENCLAW_AGENT_DIR = `${HOME_DIR}/.openclaw-agent`;
const OPENCLAW_LAUNCHER_PATH = `${OPENCLAW_CONFIG_DIR}/start-openclaw-gateway.sh`;
const OPENCLAW_CONFIG_PATH = `${OPENCLAW_CONFIG_DIR}/openclaw.json`;
const OPENCLAW_LOG_PATH = `${OPENCLAW_CONFIG_DIR}/gateway.log`;
const NODE_BIN_DIR = "/vercel/runtimes/node24/bin";
const CONTROL_UI_BOOTSTRAP_PATH = "/__openclaw/control-ui-config.json";
export const OPENCLAW_STARTUP_LEASE_CUSHION_MS = 180_000;

export type OpenClawSandboxConfig = {
  installSpec: string;
  aiGatewayApiUrl: string;
  aiGatewayModel: string;
  gatewayApiKey: string;
  gatewayPort: number;
};

type OpenClawSessionHandle = Awaited<ReturnType<PublicWorkspaceHandle["sandbox"]["attachSession"]>>;

type ActiveSandboxLease = Awaited<ReturnType<PublicWorkspaceHandle["sandbox"]["getActiveLease"]>>;

type OpenClawStartProgressPhase = "session_started" | "server_started" | "ready";

type OpenClawSessionUpdateFn = (sessionId: string, update: OpenClawSessionUpdate) => Promise<void>;

export function withRetry<T>(
  action: (attempt: number) => Promise<T>,
  attempts = 6,
  baseMs = 500,
): Promise<T> {
  // Keep retries sequential so failures are diagnosed and retried one-at-a-time.
  return (async () => {
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
  })();
}

function buildOpenClawConfig(
  authToken: string,
  controlUiOrigin: string,
  options: OpenClawSandboxConfig,
): string {
  const modelRef = `sandbox-gateway/${options.aiGatewayModel}`;
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
        port: options.gatewayPort,
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
            baseUrl: options.aiGatewayApiUrl,
            apiKey: options.gatewayApiKey,
            authHeader: true,
            api: "openai-completions",
            models: [
              {
                id: options.aiGatewayModel,
                name: options.aiGatewayModel,
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

function buildLauncherScript(port: number): string {
  return `#!/usr/bin/env bash
set -euo pipefail
export HOME='${HOME_DIR}'
export OPENCLAW_AGENT_DIR='${OPENCLAW_AGENT_DIR}'
export OPENCLAW_CONFIG_PATH='${OPENCLAW_CONFIG_PATH}'
export PATH='${NODE_BIN_DIR}:${NPM_PREFIX}/bin:/usr/local/bin:/usr/bin:/bin'

: > '${OPENCLAW_LOG_PATH}'
exec '${NPM_PREFIX}/bin/openclaw' gateway run --port ${port} >> '${OPENCLAW_LOG_PATH}' 2>&1
`;
}

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

function sandboxOriginFromUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    throw new Error(`OpenClaw session URL is not parseable: ${url}`);
  }
}

function randomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function runCheckedInSession(
  session: OpenClawSessionHandle,
  command: string,
  args: string[],
  label: string,
) {
  return runCheckedInSessionImpl(session, command, args, label);
}

async function runCheckedInSessionImpl(
  session: OpenClawSessionHandle,
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

function runChecked(
  workspace: PublicWorkspaceHandle,
  command: string,
  args: string[],
  label: string,
) {
  return runCheckedImpl(workspace, command, args, label);
}

async function runCheckedImpl(
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

function buildSandboxReadyCommand(sandboxUrl: string): string {
  return `${sandboxUrl}${CONTROL_UI_BOOTSTRAP_PATH}`;
}

export async function isOpenClawReady(
  url: string,
  _options: OpenClawSandboxConfig,
): Promise<boolean> {
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

export async function waitForOpenClawReady(
  url: string,
  _options: OpenClawSandboxConfig,
): Promise<void> {
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

export async function waitForSessionUrl(
  session: OpenClawSessionHandle,
  options: OpenClawSandboxConfig,
): Promise<string> {
  return withRetry(
    async (attempt) => {
      console.info("[openclaw] waitForSessionUrl attempt", {
        attempt,
        port: options.gatewayPort,
      });
      return session.url(options.gatewayPort);
    },
    20,
    700,
  );
}

export async function readBootstrapStatusWithSession(
  session: OpenClawSessionHandle,
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

export async function readBootstrapStatusInWorkspace(
  workspace: PublicWorkspaceHandle,
): Promise<boolean> {
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

export async function readSessionToken(session: OpenClawSessionHandle): Promise<string> {
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

export async function probeLocalGateway(
  session: OpenClawSessionHandle,
  options: OpenClawSandboxConfig,
): Promise<void> {
  await withRetry(
    async (attempt) => {
      console.info("[openclaw] probeLocalGateway attempt", {
        attempt,
        port: options.gatewayPort,
      });
      const result = await session.exec("bash", [
        "-lc",
        [
          "set -euo pipefail",
          "tmp_headers=$(mktemp)",
          "tmp_body=$(mktemp)",
          `curl --connect-timeout 2 --max-time 4 -sS -D "$tmp_headers" -o "$tmp_body" 'http://127.0.0.1:${options.gatewayPort}${CONTROL_UI_BOOTSTRAP_PATH}'`,
          'body=$(cat "$tmp_body")',
          'if [ -z "$body" ]; then',
          "  echo 'local gateway returned empty payload' >&2",
          "  sed -n '1,20p' \"$tmp_headers\" >&2 || true",
          "  exit 1",
          "fi",
          'printf "%s" "$body"',
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

export async function stopGatewayProcess(session: OpenClawSessionHandle): Promise<void> {
  await session.exec("bash", [
    "-lc",
    [
      "set -euo pipefail",
      `pkill -f "${NPM_PREFIX}/bin/openclaw gateway run" || true`,
      `pkill -f "${OPENCLAW_LAUNCHER_PATH}" || true`,
    ].join("\n"),
  ]);
}

export async function collectGatewayDiagnostics(session: OpenClawSessionHandle): Promise<string> {
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

export async function updateControlUiConfigForSession(
  session: OpenClawSessionHandle,
  sandboxUrl: string,
  options: OpenClawSandboxConfig,
): Promise<void> {
  const tokenResult = await session.exec("bash", [
    "-lc",
    `cat '${OPENCLAW_CONFIG_DIR}/auth-token.txt'`,
  ]);
  const authToken = tokenResult.stdout.trim();
  const controlUiOrigin = sandboxOriginFromUrl(sandboxUrl);
  const encodedConfig = Buffer.from(
    buildOpenClawConfig(authToken, controlUiOrigin, options),
  ).toString("base64");

  await session.exec("bash", [
    "-lc",
    `printf '%s' '${encodedConfig}' | base64 -d > '${OPENCLAW_CONFIG_PATH}'`,
  ]);
}

export async function bootstrapOpenClawInWorkspace(
  workspace: PublicWorkspaceHandle,
  options: OpenClawSandboxConfig,
): Promise<void> {
  const authToken = randomToken();
  const openclawConfig = buildOpenClawConfig(authToken, "http://127.0.0.1", options);
  const encodedConfig = Buffer.from(openclawConfig).toString("base64");
  const encodedToken = Buffer.from(buildLauncherScript(options.gatewayPort)).toString("base64");

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
    ["install", "-g", "--prefix", NPM_PREFIX, options.installSpec],
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

export async function repairOpenClawInSession(
  session: OpenClawSessionHandle,
  options: OpenClawSandboxConfig,
): Promise<void> {
  const authToken = randomToken();
  const openclawConfig = buildOpenClawConfig(authToken, "http://127.0.0.1", options);
  const encodedConfig = Buffer.from(openclawConfig).toString("base64");
  const encodedLauncher = Buffer.from(buildLauncherScript(options.gatewayPort)).toString("base64");

  await runCheckedInSession(
    session,
    "bash",
    ["-lc", `mkdir -p '${OPENCLAW_CONFIG_DIR}' '${OPENCLAW_AGENT_DIR}' '${NPM_PREFIX}'`],
    "prepare sandbox directories",
  );

  await runCheckedInSession(
    session,
    "npm",
    ["install", "-g", "--prefix", NPM_PREFIX, options.installSpec],
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

export async function ensureGatewayRunning(
  workspace: PublicWorkspaceHandle,
  openclawSession: OpenClawSessionRecord,
  updateSession: OpenClawSessionUpdateFn,
  options: OpenClawSandboxConfig,
  requiredLeaseMs: number,
  onProgress?: (phase: OpenClawStartProgressPhase) => Promise<void>,
): Promise<{
  url: string;
  lease: NonNullable<ActiveSandboxLease>;
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
  const sessionLease = existingLease ?? (await workspace.sandbox.getActiveLease());

  sessionResolutionStep.success({
    attachedExisting,
    sandboxId: existingLease?.sandboxId ?? null,
  });
  if (requiredLeaseMs > 0 && sessionLease) {
    const extendByMs = requiredLeaseMs - sessionLease.remainingMs;
    if (extendByMs > 0) {
      await activeSession.extendTimeout(extendByMs);
    }
  }
  if (onProgress) {
    await onProgress("session_started");
  }

  const sessionUrlStep = logTimedStepStart("waitForSessionUrl", {
    workspaceId: workspace.id,
    openclawSessionId: openclawSession.id,
  });
  const url = await waitForSessionUrl(activeSession, options);
  sessionUrlStep.success({ url });

  const bootstrapStatusStep = logTimedStepStart("readBootstrapStatus", {
    workspaceId: workspace.id,
    openclawSessionId: openclawSession.id,
  });
  let bootstrapReady = await readBootstrapStatusWithSession(activeSession);
  bootstrapStatusStep.success({ bootstrapReady });
  let didRepairBootstrap = false;
  if (!bootstrapReady) {
    const bootstrapRepairStep = logTimedStepStart("bootstrapRepair", {
      workspaceId: workspace.id,
      openclawSessionId: openclawSession.id,
      phase: "repairing",
    });

    await updateSession(openclawSession.id, {
      phase: "repairing",
      error_code: "bootstrap_missing",
      error_message: "OpenClaw bootstrap artifacts missing; attempting repair.",
      updated_at: new Date(),
    });
    await repairOpenClawInSession(activeSession, options);
    bootstrapReady = await readBootstrapStatusWithSession(activeSession);
    didRepairBootstrap = true;
    bootstrapRepairStep.success({ bootstrapReady });
  }

  if (!bootstrapReady) {
    const bootstrapRepairMode = didRepairBootstrap ? "repair attempt" : "initial bootstrap check";
    const finalBootstrapFailureStep = logTimedStepStart("bootstrapMissingFailure", {
      workspaceId: workspace.id,
      openclawSessionId: openclawSession.id,
    });
    await updateSession(openclawSession.id, {
      phase: "failed",
      error_code: "bootstrap_missing",
      error_message: `OpenClaw bootstrap artifacts are still missing for session ${openclawSession.id} after ${bootstrapRepairMode}.`,
      updated_at: new Date(),
    });
    finalBootstrapFailureStep.failure(
      new Error(
        `OpenClaw bootstrap artifacts are still missing for session ${openclawSession.id} after ${bootstrapRepairMode}.`,
      ),
    );
    throw new Error(
      `OpenClaw bootstrap artifacts are still missing for session ${openclawSession.id} after ${bootstrapRepairMode}.`,
    );
  }

  const controlUiConfigStep = logTimedStepStart("updateControlUiConfig", {
    workspaceId: workspace.id,
    openclawSessionId: openclawSession.id,
    url,
  });
  await updateControlUiConfigForSession(activeSession, url, options);
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
    if (onProgress) {
      await onProgress("server_started");
    }
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
      onStdout: (chunk: string) => {
        gatewayProcessOutput.onStdout(chunk);
      },
      onStderr: (chunk: string) => {
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
      await probeLocalGateway(activeSession, options);
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
    if (!didRepairBootstrap && attachedExisting) {
      const localProbeStep = logTimedStepStart("probeLocalGateway", {
        workspaceId: workspace.id,
        openclawSessionId: openclawSession.id,
        phase: "server_starting",
        attempt: "initial",
      });
      await probeLocalGateway(activeSession, options);
      localProbeStep.success();
    } else {
      console.info("[openclaw] skipping initial localhost probe", {
        workspaceId: workspace.id,
        openclawSessionId: openclawSession.id,
        didRepairBootstrap,
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
  await waitForOpenClawReady(url, options);
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

export async function waitForOpenClawGatewayReady(
  url: string,
  options: OpenClawSandboxConfig,
): Promise<void> {
  await waitForOpenClawReady(url, options);
}

export { isOpenClawPublicPhase };
