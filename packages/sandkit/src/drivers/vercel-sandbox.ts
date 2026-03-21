import { Sandbox } from "@vercel/sandbox";

import type { WorkspacePolicy } from "../policies/types.ts";
import type {
  CommandResult,
  PersistedSandboxState,
  SandboxSessionLease,
  SandboxDriver,
  WorkspaceSessionProcess,
  SandboxCreateOptions,
  SandboxDriverFactory,
  WorkspaceRecord,
} from "../types.ts";
import { compileVercelNetworkPolicy } from "./vercel-network-policy.ts";

interface VercelCommandFinished {
  exitCode: number;
  stdout(): Promise<string>;
  stderr(): Promise<string>;
}

interface VercelCommandHandle {
  wait(): Promise<VercelCommandFinished>;
  readonly cmdId?: string;
}

interface VercelPersistedState {
  snapshotId?: string;
}

export interface VercelSandboxDriverFactoryOptions {
  runtime?: string;
  timeout?: number;
}

class VercelSandboxDriver implements SandboxDriver {
  readonly #sandbox: Awaited<ReturnType<typeof Sandbox.get>>;
  readonly provider = "vercel-sandbox";

  constructor(sandbox: Awaited<ReturnType<typeof Sandbox.get>>) {
    this.#sandbox = sandbox;
  }

  get id(): string {
    return this.#sandbox.sandboxId;
  }

  async applyPolicy(policy: WorkspacePolicy): Promise<void> {
    await this.#sandbox.updateNetworkPolicy(compileVercelNetworkPolicy(policy));
  }

  async getSessionLease(): Promise<SandboxSessionLease> {
    const sandbox = this.#sandbox;
    const observedAt = new Date().toISOString();
    const timeoutMs =
      typeof sandbox.timeout === "number" && Number.isFinite(sandbox.timeout) && sandbox.timeout > 0
        ? sandbox.timeout
        : 60_000;

    return {
      sandboxId: sandbox.sandboxId,
      observedAt,
      expiresAt: new Date(Date.parse(observedAt) + timeoutMs).toISOString(),
    };
  }

  async runCommand(command: string, args: string[]): Promise<CommandResult> {
    const result = await this.#sandbox.runCommand(command, args);
    const finished = await this.#toCommandFinished(result);

    return {
      exitCode: finished.exitCode,
      stdout: await finished.stdout(),
      stderr: await finished.stderr(),
    };
  }

  async startProcess(command: string, args: string[]): Promise<WorkspaceSessionProcess> {
    const started = await this.#sandbox.runCommand({
      cmd: command,
      args,
      detached: true,
    });
    if (!isVercelCommandHandle(started)) {
      throw new Error("Unexpected Vercel sandbox startProcess() response shape.");
    }

    const processId = started.cmdId ?? `${this.#sandbox.sandboxId}-${Date.now()}`;
    return {
      processId,
      wait: async (): Promise<CommandResult> => {
        const finished = await started.wait();
        return {
          exitCode: finished.exitCode,
          stdout: await finished.stdout(),
          stderr: await finished.stderr(),
        };
      },
    };
  }

  async url(port: number): Promise<string> {
    return this.#sandbox.domain(port);
  }

  async extendTimeout(durationMs: number): Promise<void> {
    const extendTimeout = (
      this.#sandbox as { extendTimeout?: (durationMs: number) => Promise<unknown> }
    ).extendTimeout;
    if (!extendTimeout) {
      throw new Error("This Vercel sandbox does not support extendTimeout().");
    }

    await extendTimeout.call(this.#sandbox, durationMs);
  }

  async snapshot(): Promise<PersistedSandboxState> {
    // Vercel sandbox snapshot() restores through a new sandbox and implicitly stops the source sandbox.
    // Keep this behavior as a provider detail in the driver implementation.
    const snapshot = await this.#sandbox.snapshot();

    return {
      kind: "vercel-sandbox-snapshot",
      sessionId: this.#sandbox.sandboxId,
      state: {
        snapshotId: snapshot.snapshotId,
      },
    };
  }

  async #toCommandFinished(raw: unknown): Promise<VercelCommandFinished> {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("Unexpected Vercel sandbox command response");
    }

    const candidate = raw as { wait?: () => Promise<VercelCommandFinished> };
    if (candidate.wait) {
      return candidate.wait();
    }

    return raw as VercelCommandFinished;
  }
}

function isVercelCommandHandle(value: unknown): value is VercelCommandHandle {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as { wait?: unknown; cmdId?: unknown };
  if (typeof candidate.wait !== "function") {
    return false;
  }

  return candidate.cmdId === undefined || typeof candidate.cmdId === "string";
}

class VercelSandboxDriverFactory implements SandboxDriverFactory {
  readonly #runtime: string;
  readonly #timeout: number;

  constructor(options: VercelSandboxDriverFactoryOptions = {}) {
    this.#runtime = options.runtime ?? "node24";
    this.#timeout = options.timeout ?? 60_000;
  }

  isSessionUnavailableError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const message = error.message.toLowerCase();
    return (
      message.includes("not found") ||
      message.includes("does not exist") ||
      message.includes("sandbox_stopped") ||
      message.includes("sandbox stopped")
    );
  }

  async createSandbox(
    _workspace: WorkspaceRecord,
    options: SandboxCreateOptions,
  ): Promise<SandboxDriver> {
    const sandbox = await Sandbox.create({
      runtime: this.#runtime,
      timeout: this.#timeout,
      networkPolicy: compileVercelNetworkPolicy(options.policy),
    });

    return new VercelSandboxDriver(sandbox);
  }

  async resumeSandbox(
    workspace: WorkspaceRecord,
    snapshot: PersistedSandboxState,
    options: SandboxCreateOptions,
  ): Promise<SandboxDriver> {
    const state = snapshot.state as VercelPersistedState | undefined;
    const snapshotId = state?.snapshotId;
    const fallbackSandboxId = workspace.sandboxId ?? snapshot.sessionId;

    const sandbox =
      snapshotId === undefined || typeof snapshotId !== "string"
        ? await (fallbackSandboxId === undefined
            ? (() => {
                throw new Error("Persisted sandbox state is missing restore information");
              })()
            : Sandbox.get({ sandboxId: fallbackSandboxId }))
        : await Sandbox.create({
            source: {
              type: "snapshot",
              snapshotId,
            },
            timeout: this.#timeout,
            networkPolicy: compileVercelNetworkPolicy(options.policy),
          });

    const driver = new VercelSandboxDriver(sandbox);
    if (snapshotId === undefined || typeof snapshotId !== "string") {
      await driver.applyPolicy(options.policy);
    }
    return driver;
  }
}

export function createVercelSandboxDriverFactory(
  options: VercelSandboxDriverFactoryOptions = {},
): SandboxDriverFactory {
  return new VercelSandboxDriverFactory(options);
}
