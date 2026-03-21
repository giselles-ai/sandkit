import { Sandbox } from "@vercel/sandbox";

import type { WorkspacePolicy } from "../policies/types.ts";
import type {
  CommandResult,
  PersistedSandboxState,
  SandboxDriver,
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

  async runCommand(command: string, args: string[]): Promise<CommandResult> {
    const result = await this.#sandbox.runCommand(command, args);
    const finished = await this.#toCommandFinished(result);

    return {
      exitCode: finished.exitCode,
      stdout: await finished.stdout(),
      stderr: await finished.stderr(),
    };
  }

  async snapshot(): Promise<PersistedSandboxState> {
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

class VercelSandboxDriverFactory implements SandboxDriverFactory {
  readonly #runtime: string;
  readonly #timeout: number;

  constructor(options: VercelSandboxDriverFactoryOptions = {}) {
    this.#runtime = options.runtime ?? "node24";
    this.#timeout = options.timeout ?? 60_000;
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
