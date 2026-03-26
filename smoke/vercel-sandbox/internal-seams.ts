import type { Command } from "../../packages/sandkit/src/types.ts";

/**
 * Internal seam helper for smoke tests that intentionally consume package internals.
 * Not part of consumer-facing API tests.
 */
export { runGenerateCommand } from "../../packages/sandkit/src/cli/generate.ts";
export { compileVercelNetworkPolicy } from "../../packages/sandkit/src/drivers/vercel-network-policy.ts";
export { evaluateWorkspacePolicy } from "../../packages/sandkit/src/policies/evaluator.ts";

type RunStatus = "started" | "succeeded" | "failed";

export type InternalRunAdapterContract = {
  createRun(input: {
    workspaceId: string;
    provider: string;
    executionTargetId: string;
    command: string;
    args?: string[];
    status?: RunStatus;
    startedAt?: string;
    policySnapshotId?: string;
  }): Promise<unknown>;
  finishRun(
    id: string,
    input: {
      status: RunStatus;
      finishedAt?: string;
      exitCode?: number | null;
      stdout?: string | null;
      stderr?: string | null;
      policySnapshotId?: string;
      providerCommit?: unknown;
    },
  ): Promise<unknown>;
};

export type InternalSandkitAdapterContract = {
  runs: InternalRunAdapterContract;
  workspaces: {
    getWorkspace: (id: string) => Promise<unknown>;
    updateWorkspace: (
      id: string,
      input: {
        metadata?: Record<string, unknown>;
        name?: string;
        sandboxId?: string | null;
        status?: "active" | "inactive" | "archived";
        lastResumedAt?: string | null;
      },
    ) => Promise<unknown>;
    createWorkspace: (input: { id?: string }) => Promise<unknown>;
  };
  id: string;
  policySnapshots: {
    createPolicySnapshot: (input: {
      workspaceId: string;
      policyId: string;
      config: unknown;
      createdAt?: string;
      id?: string;
    }) => Promise<unknown>;
  };
};

export type InternalSandboxDriverFactoryContract = {
  createSandbox(...args: unknown[]): Promise<{
    id: string;
    provider: string;
    applyPolicy(...args: unknown[]): Promise<void>;
    getSessionLease: () => Promise<{
      sandboxId: string;
      observedAt: string;
      expiresAt: string;
    }>;
    runCommand: (
      command: string,
      args: string[],
      options?: { detached?: boolean },
    ) => Promise<Command>;
    snapshot: () => Promise<unknown>;
  }>;
  resumeSandbox: (...args: unknown[]) => Promise<{
    id: string;
    provider: string;
    applyPolicy(...args: unknown[]): Promise<void>;
    getSessionLease: () => Promise<{
      sandboxId: string;
      observedAt: string;
      expiresAt: string;
    }>;
    runCommand: (
      command: string,
      args: string[],
      options?: { detached?: boolean },
    ) => Promise<Command>;
    snapshot: () => Promise<unknown>;
  }>;
  isSessionUnavailableError?: (error: unknown) => boolean;
};
