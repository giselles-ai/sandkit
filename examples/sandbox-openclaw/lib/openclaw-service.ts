import type { PublicWorkspaceHandle } from "sandkit";

import { getOpenClawRuntime, type OpenClawRuntime } from "./openclaw-app";
import {
  bootstrapOpenClawInWorkspace,
  ensureGatewayRunning,
  OPENCLAW_STARTUP_LEASE_CUSHION_MS,
  isOpenClawReady,
  readBootstrapStatusInWorkspace,
  readSessionToken,
  waitForOpenClawGatewayReady,
  waitForSessionUrl,
  type OpenClawSandboxConfig,
} from "./openclaw-sandbox";
import {
  isOpenClawSessionRecordReusableForStart,
  type OpenClawPublicPhase,
  type OpenClawSessionRecord,
  type OpenClawSessionUpdate,
  type OpenClawStore,
} from "./openclaw-store";

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

export type OpenClawStartProgressPhase = "session_started" | "server_started" | "ready";

type OpenClawStartStep = "resolve_start_attempt" | "ensure_gateway_running" | "public_ready";

export type OpenClawStartProgress = {
  onPhase?: (
    phase: OpenClawStartProgressPhase,
    details: {
      openclawSessionId?: string;
      sandboxId?: string;
      message?: string;
      ts?: string;
    },
  ) => Promise<void> | void;
  onStep?: (input: {
    step: OpenClawStartStep;
    status: "started" | "completed";
    detail?: string;
    ts?: string;
  }) => Promise<void> | void;
};

type OpenClawCreateStep =
  | "prepare_workspace"
  | "durable_bootstrap"
  | "verify_bootstrap";

type OpenClawCreateProgress = {
  onStep?: (input: {
    step: OpenClawCreateStep;
    status: "started" | "completed";
    detail?: string;
    ts?: string;
  }) => Promise<void> | void;
  onPhase?: (
    _phase: string,
    _details: Record<string, unknown>,
  ) => Promise<void> | void;
};

type Runtime = {
  readonly workspace: () => Promise<PublicWorkspaceHandle | null>;
  readonly getState: () => Promise<OpenClawState>;
  readonly createWorkspace: (progress?: OpenClawCreateProgress) => Promise<OpenClawState>;
  readonly startSession: (
    durationMs?: number,
    progress?: OpenClawStartProgress,
  ) => Promise<OpenClawState>;
  readonly extendSession: (durationMs: number) => Promise<OpenClawState>;
  readonly commitSession: () => Promise<OpenClawState>;
};

type OpenClawRuntimeFacade = {
  runtime: OpenClawRuntime;
  getSandboxConfig: () => OpenClawSandboxConfig;
};

type OpenClawStoreLike = OpenClawStore;

let runtimePromise: Promise<Runtime> | null = null;

function parsePositiveInteger(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    return fallback;
  }

  return value;
}

function createLogStep(step: string, context: Record<string, unknown> = {}) {
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

function nowDate(): Date {
  return new Date();
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

export { isOpenClawSessionRecordReusableForStart };

async function resolveWorkspace(
  facade: OpenClawRuntimeFacade,
  workspaceId: string,
): Promise<PublicWorkspaceHandle | null> {
  try {
    return await facade.runtime.app.getWorkspace(workspaceId);
  } catch {
    return null;
  }
}

function composeSandboxConfig(runtime: OpenClawRuntime): OpenClawSandboxConfig {
  return {
    installSpec: runtime.config.openclawInstallSpec,
    aiGatewayApiUrl: runtime.config.aiGatewayApiUrl,
    aiGatewayModel: runtime.config.aiGatewayModel,
    gatewayApiKey: runtime.config.gatewayApiKey,
    gatewayPort: runtime.config.gatewayPort,
  };
}

function createStoreOnlyFacade(runtime: OpenClawRuntime): OpenClawRuntimeFacade {
  return {
    runtime,
    getSandboxConfig: () => composeSandboxConfig(runtime),
  };
}

function createReadState(
  facade: OpenClawRuntimeFacade,
  store: OpenClawStoreLike,
): () => Promise<OpenClawState> {
  return async function getState(): Promise<OpenClawState> {
    const runtime = facade.runtime;
    const workspace = await resolveWorkspace(facade, runtime.config.workspaceId);
    if (!workspace) {
      return {
        hasWorkspace: false,
        hasActiveSession: false,
      };
    }

    const hasDurableBootstrap = await store.hasDurableOpenClawBootstrap(workspace.id);
    const workspaceSummary = await store.loadOpenClawSummary(workspace.id);
    const activeSessionRecord = workspaceSummary.activeSessionId
      ? await store.getOpenClawSessionById(workspaceSummary.activeSessionId)
      : await store.getLatestUnfinishedSession(workspace.id);
    const workspaceState = await readActiveWorkspaceState(
      workspace,
      activeSessionRecord?.public_url ?? null,
      facade,
    );
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
  };
}

async function readActiveWorkspaceState(
  workspace: PublicWorkspaceHandle,
  knownPublicUrl: string | null,
  facade: OpenClawRuntimeFacade,
): Promise<Pick<
  OpenClawState,
  "hasActiveSession" | "sandboxId" | "remainingMs" | "expiresAt" | "openclawUrl" | "connectCommand"
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
  const config = facade.getSandboxConfig();

  try {
    if (knownPublicUrl) {
      if (!(await isOpenClawReady(knownPublicUrl, config))) {
        return baseState;
      }

      const session = await workspace.sandbox.attachSession();
      const token = await readSessionToken(session);
      const uiUrl = token ? `${knownPublicUrl}#token=${encodeURIComponent(token)}` : knownPublicUrl;
      return {
        ...baseState,
        openclawUrl: uiUrl,
      };
    }

    const session = await workspace.sandbox.attachSession();
    const openclawUrl = await waitForSessionUrl(session, config);
    if (!(await isOpenClawReady(openclawUrl, config))) {
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

function createRuntimeActions(runtime: OpenClawRuntime): Runtime {
  const store = runtime.store;
  const facade: OpenClawRuntimeFacade = createStoreOnlyFacade(runtime);

  async function loadWorkspace(): Promise<PublicWorkspaceHandle | null> {
    return resolveWorkspace(facade, runtime.config.workspaceId);
  }

  async function workspaceOrThrow(): Promise<PublicWorkspaceHandle> {
    const workspace = await loadWorkspace();
    if (!workspace) {
      throw new Error("Workspace does not exist.");
    }

    return workspace;
  }

  async function withActiveSession<T>(
    workspace: PublicWorkspaceHandle,
    action: (session: Awaited<ReturnType<typeof workspace.sandbox.attachSession>>) => Promise<T>,
  ): Promise<T> {
    const session = await workspace.sandbox.attachSession();
    return action(session);
  }

  async function bootstrapSessionRecord(session: OpenClawSessionRecord): Promise<boolean> {
    const workspace = await workspaceOrThrow();
    try {
      await bootstrapOpenClawInWorkspace(workspace, facade.getSandboxConfig());
    } catch (error) {
      await store.updateOpenClawSessionRecord(session.id, {
        phase: "failed",
        error_code: "bootstrap_failed",
        error_message: error instanceof Error ? error.message : String(error),
        updated_at: nowDate(),
      });
      return false;
    }
    const bootstrapReady = await readBootstrapStatusInWorkspace(workspace);

    if (!bootstrapReady) {
      await store.updateOpenClawSessionRecord(session.id, {
        phase: "failed",
        error_code: "bootstrap_failed",
        error_message: "OpenClaw bootstrap artifacts missing after install.",
        updated_at: nowDate(),
      });
      return false;
    }

    await store.updateOpenClawSessionRecord(session.id, {
      phase: "bootstrapped",
      error_code: null,
      error_message: null,
      updated_at: nowDate(),
    });
    return true;
  }

  function isErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async function markSessionFailure(
    workspaceId: string,
    session: OpenClawSessionRecord,
    reason: string,
    options?: {
      activeSessionId?: string | null;
    },
  ): Promise<never> {
    const timestamp = nowDate();
    const previousSummary = await store.loadOpenClawSummary(workspaceId);
    const hasDurableBootstrap = await store.hasDurableOpenClawBootstrap(workspaceId);
    await store.updateOpenClawSessionRecord(session.id, {
      phase: "failed",
      error_code: "transition_failed",
      error_message: reason,
      finished_at: timestamp,
      updated_at: timestamp,
    });
    await store.updateOpenClawSummary(workspaceId, {
      ...(hasDurableBootstrap ? { phase: previousSummary.phase } : {}),
      activeSessionId:
        options?.activeSessionId === undefined
          ? hasDurableBootstrap
            ? previousSummary.activeSessionId
            : null
          : options.activeSessionId,
      lastErrorAt: timestamp.toISOString(),
    });
    throw new Error(reason);
  }

  async function getState(): Promise<OpenClawState> {
    return createReadState(facade, store)();
  }

  async function createWorkspace(progress?: OpenClawCreateProgress): Promise<OpenClawState> {
    const emitStep: OpenClawCreateProgress["onStep"] = async (input) => {
      if (progress?.onStep) {
        await progress.onStep({ ...input, ts: new Date().toISOString() });
      }
    };

    const createStep = createLogStep("createWorkspace", {
      workspaceId: runtime.config.workspaceId,
    });
    const existing = await loadWorkspace();
    if (existing) {
      throw new Error("Workspace already exists.");
    }

    await emitStep({ step: "prepare_workspace", status: "started" });
    const workspace = await runtime.app.createWorkspace({
      id: runtime.config.workspaceId,
      name: "openclaw-demo",
    });
    await emitStep({
      step: "prepare_workspace",
      status: "completed",
      detail: `Created workspace ${workspace.id}.`,
    });

    await emitStep({ step: "durable_bootstrap", status: "started" });
    const session = await store.createOpenClawSession(
      workspace.id,
      "bootstrapping",
      runtime.config.openclawInstallSpec,
    );
    const bootstrapped = await bootstrapSessionRecord(session);
    await emitStep({
      step: "durable_bootstrap",
      status: "completed",
      detail: `Durable bootstrap installation ran for workspace ${workspace.id}.`,
    });
    await emitStep({ step: "verify_bootstrap", status: "started" });
    if (!bootstrapped) {
      await markSessionFailure(
        workspace.id,
        session,
        "OpenClaw bootstrap artifacts missing after initial bootstrap.",
        {
          activeSessionId: null,
        },
      );
    }

    await emitStep({
      step: "verify_bootstrap",
      status: "completed",
      detail: `Verified bootstrap artifacts for workspace ${workspace.id}.`,
    });
    await store.updateOpenClawSummary(workspace.id, {
      phase: "bootstrapped",
      activeSessionId: null,
      lastErrorAt: null,
    });
    createStep.success({
      workspaceId: workspace.id,
    });
    return getState();
  }

  async function startSession(
    durationMs?: number,
    progress?: OpenClawStartProgress,
  ): Promise<OpenClawState> {
    const safeDurationMs = parsePositiveInteger(durationMs ?? 0, 0);
    const startSessionStep = createLogStep("startSession", {});
    const emitPhase: OpenClawStartProgress["onPhase"] = async (phase, details) => {
      if (progress?.onPhase) {
        await progress.onPhase(phase, { ...details, ts: new Date().toISOString() });
      }
    };
    const emitStep: OpenClawStartProgress["onStep"] = async (input) => {
      if (progress?.onStep) {
        await progress.onStep({ ...input, ts: new Date().toISOString() });
      }
    };
    const workspace = await workspaceOrThrow();
    const session = await store.getOrCreateActiveSession(
      workspace.id,
      runtime.config.openclawInstallSpec,
    );

    await emitStep({ step: "resolve_start_attempt", status: "started" });
    await emitStep({ step: "resolve_start_attempt", status: "completed" });
    await emitStep({ step: "ensure_gateway_running", status: "started" });

    let startupResult:
      | {
          url: string;
          lease: NonNullable<
            Awaited<ReturnType<PublicWorkspaceHandle["sandbox"]["getActiveLease"]>>
          >;
        }
      | undefined;
    let didFail = false;

    const requiredLeaseMs =
      safeDurationMs > 0 ? safeDurationMs : OPENCLAW_STARTUP_LEASE_CUSHION_MS;

    try {
      const config = facade.getSandboxConfig();
      startupResult = await ensureGatewayRunning(
        workspace,
        session,
        async (openclawSessionId, update: OpenClawSessionUpdate) => {
          await store.updateOpenClawSessionRecord(openclawSessionId, update);
        },
        config,
        requiredLeaseMs,
        async (phase: OpenClawStartProgressPhase) => {
          await emitPhase(phase, { openclawSessionId: session.id });
          await store.updateOpenClawSummary(workspace.id, {
            phase,
            activeSessionId: session.id,
            lastErrorAt: null,
          });
        },
      );
      const isReady = await isOpenClawReady(startupResult.url, config);
      if (!isReady) {
        didFail = true;
        await markSessionFailure(
          workspace.id,
          session,
          "OpenClaw UI is not publicly reachable after startup.",
          {
            activeSessionId: session.id,
          },
        );
      } else {
        await store.updateOpenClawSummary(workspace.id, {
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
        `Failed to start OpenClaw session: ${isErrorMessage(error)}`,
        {
          activeSessionId: session.id,
        },
      );
    }

    let nextState: OpenClawState;
    if (!didFail && startupResult) {
      await emitStep({ step: "ensure_gateway_running", status: "completed" });
      await emitStep({ step: "public_ready", status: "started" });
      await waitForOpenClawGatewayReady(startupResult.url, facade.getSandboxConfig());
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
      await emitStep({ step: "public_ready", status: "completed" });
      await emitPhase("ready", {
        openclawSessionId: session.id,
        sandboxId: startupResult.lease.sandboxId,
        message: `OpenClaw started on session ${session.id}.`,
      });
    } else {
      await emitStep({ step: "ensure_gateway_running", status: "completed" });
      const getStateStep = createLogStep("startSession.getState", {
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
    const summary = await store.loadOpenClawSummary(workspace.id);
    await store.updateOpenClawSummary(workspace.id, {
      phase: "ready",
      activeSessionId: summary.activeSessionId,
      lastErrorAt: null,
    });

    return getState();
  }

  async function commitSession(): Promise<OpenClawState> {
    const workspace = await workspaceOrThrow();
    const summary = await store.loadOpenClawSummary(workspace.id);
    const lease = await workspace.sandbox.getActiveLease();

    if (!lease) {
      throw new Error("No active session to commit.");
    }

    const resolvedSession = summary.activeSessionId
      ? await store.getOpenClawSessionById(summary.activeSessionId)
      : null;
    const activeSession = resolvedSession ?? (await store.getLatestUnfinishedSession(workspace.id));

    if (!activeSession) {
      throw new Error("No active OpenClaw session exists to commit.");
    }

    await withActiveSession(workspace, async (session) => {
      await session.commit();
    });

    const finishAt = nowDate();
    await store.updateOpenClawSessionRecord(activeSession.id, {
      finished_at: finishAt,
      updated_at: finishAt,
    });
    await store.updateOpenClawSummary(workspace.id, {
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

async function getRuntime(): Promise<Runtime> {
  if (!runtimePromise) {
    runtimePromise = createRuntime();
  }

  return runtimePromise;
}

async function createRuntime(): Promise<Runtime> {
  const runtime = await getOpenClawRuntime();
  return createRuntimeActions(runtime);
}

export async function readState(): Promise<OpenClawState> {
  const runtime = await getRuntime();
  return runtime.getState();
}

export async function createWorkspace(progress?: OpenClawCreateProgress): Promise<OpenClawState> {
  const runtime = await getRuntime();
  return runtime.createWorkspace(progress);
}

export async function startSession(
  durationMs?: number,
  progress?: OpenClawStartProgress,
): Promise<OpenClawState> {
  const runtime = await getRuntime();
  return runtime.startSession(durationMs, progress);
}

export async function extendSession(durationMs: number): Promise<OpenClawState> {
  const runtime = await getRuntime();
  return runtime.extendSession(durationMs);
}

export async function commitSession(): Promise<OpenClawState> {
  const runtime = await getRuntime();
  return runtime.commitSession();
}
