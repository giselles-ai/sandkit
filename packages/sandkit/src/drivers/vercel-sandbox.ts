import { Sandbox } from "@vercel/sandbox";

import type { WorkspacePolicy } from "../policies/types.ts";
import type {
  Command,
  CommandResult,
  PersistedSandboxState,
  SandboxSessionLease,
  SandboxDriver,
  WorkspaceSessionLog,
  WorkspaceSessionProcess,
  WorkspaceSessionProcessStartInput,
  SandboxCreateOptions,
  SandboxDriverFactory,
  WorkspaceRecord,
  VercelSandboxOptions,
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
  readonly logs?: () => unknown;
}

interface VercelPersistedState {
  snapshotId?: string;
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

  async runCommand(
    command: string,
    args: string[],
    options?: { readonly detached?: boolean },
  ): Promise<Command> {
    const rawResult = options?.detached
      ? await this.#sandbox.runCommand({
          cmd: command,
          args,
          detached: true,
        })
      : await this.#sandbox.runCommand(command, args);

    const logIterator = options?.detached ? getCommandLogIterator(rawResult) : undefined;
    const commandLogs = logIterator
      ? () => createEphemeralCommandLogStream(logIterator)
      : undefined;

    return {
      wait: async () => {
        const finished = await this.#toCommandFinished(rawResult);
        return {
          exitCode: finished.exitCode,
          stdout: await finished.stdout(),
          stderr: await finished.stderr(),
        };
      },
      logs: commandLogs,
    };
  }

  async startProcess(input: WorkspaceSessionProcessStartInput): Promise<WorkspaceSessionProcess> {
    const started = await this.#sandbox.runCommand({
      cmd: input.command,
      args: [...input.args],
      detached: true,
    });
    if (!isVercelCommandHandle(started)) {
      throw new Error("Unexpected Vercel sandbox startProcess() response shape.");
    }

    const processId = started.cmdId ?? `${this.#sandbox.sandboxId}-${Date.now()}`;
    const commandLogBroadcast = createCommandLogBroadcaster(
      getCommandLogIterator(started),
      input.onStdout,
      input.onStderr,
    );

    return {
      processId,
      wait: async (): Promise<CommandResult> => {
        const finished = await this.#toCommandFinished(started);
        return {
          exitCode: finished.exitCode,
          stdout: await finished.stdout(),
          stderr: await finished.stderr(),
        };
      },
      logs: commandLogBroadcast ? () => commandLogBroadcast() : undefined,
    };
  }

  async url(port: number): Promise<string> {
    try {
      return this.#sandbox.domain(port);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("No route for port")) {
        throw error;
      }

      const refreshed = await Sandbox.get({ sandboxId: this.#sandbox.sandboxId });
      return refreshed.domain(port);
    }
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

function createEphemeralCommandLogStream(
  logs: AsyncIterable<unknown>,
): AsyncIterable<WorkspaceSessionLog> {
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for await (const log of logs) {
          const normalized = normalizeCommandLog(log);
          if (normalized) {
            yield normalized;
          }
        }
      } catch (cause) {
        if (cause instanceof Error) {
          throw cause;
        }
        throw new Error("Command logs failed.");
      }
    },
  };
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

function isIterable<T = unknown>(value: unknown): value is Iterable<T> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as Iterable<T>)[Symbol.iterator] === "function"
  );
}

function isAsyncIterable<T = unknown>(value: unknown): value is AsyncIterable<T> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"
  );
}

function getCommandLogIterator(raw: VercelCommandHandle): AsyncIterable<unknown> | undefined {
  const rawLogs = raw.logs?.();
  if (rawLogs === undefined) {
    return undefined;
  }
  if (isAsyncIterable<unknown>(rawLogs)) {
    return rawLogs;
  }
  if (isIterable<unknown>(rawLogs)) {
    return toAsyncIterableFromSync(rawLogs);
  }
  return undefined;
}

function toAsyncIterableFromSync<T>(iterable: Iterable<T>): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const value of iterable) {
        yield value;
      }
    },
  };
}

function createCommandLogBroadcaster(
  logs: AsyncIterable<unknown> | undefined,
  onStdout?: (chunk: string) => void,
  onStderr?: (chunk: string) => void,
): (() => AsyncIterable<WorkspaceSessionLog>) | undefined {
  if (!logs) {
    return undefined;
  }

  const bufferedLogs: WorkspaceSessionLog[] = [];
  const waiters: Array<() => void> = [];
  let completed = false;
  let error: unknown = null;
  let pumpStarted = false;

  const notifyWaiters = () => {
    while (waiters.length > 0) {
      waiters.pop()?.();
    }
  };

  const run = async (): Promise<void> => {
    if (pumpStarted) {
      return;
    }
    pumpStarted = true;

    try {
      for await (const log of logs) {
        const normalized = normalizeCommandLog(log);
        if (!normalized) {
          continue;
        }

        bufferedLogs.push(normalized);
        if (normalized.stream === "stderr") {
          onStderr?.(normalized.chunk);
        } else {
          onStdout?.(normalized.chunk);
        }
        notifyWaiters();
      }
    } catch (cause) {
      error = cause;
    } finally {
      completed = true;
      notifyWaiters();
    }
  };

  void run().catch(() => {});

  const waitForWork = (): Promise<void> => {
    return new Promise<void>((resolve) => {
      waiters.push(resolve);
    });
  };

  const createLogIterable = (): AsyncIterable<WorkspaceSessionLog> => {
    return {
      async *[Symbol.asyncIterator]() {
        let index = 0;
        while (true) {
          if (index < bufferedLogs.length) {
            yield bufferedLogs[index++]!;
            continue;
          }
          if (error !== null) {
            throw error instanceof Error ? error : new Error("startProcess logs failed.");
          }
          if (completed) {
            return;
          }
          await waitForWork();
        }
      },
    };
  };

  return createLogIterable;
}

export function normalizeCommandLog(log: unknown): WorkspaceSessionLog | null {
  if (typeof log === "string") {
    return { stream: "stdout", chunk: log };
  }
  if (typeof log !== "object" || log === null) {
    return null;
  }

  const candidate = log as {
    stream?: unknown;
    output?: unknown;
    chunk?: unknown;
    text?: unknown;
    message?: unknown;
    data?: unknown;
  };
  const streamValue = candidate.stream;
  const stream = streamValue === "stderr" || streamValue === "stdout" ? streamValue : "stdout";
  const rawChunk =
    candidate.data ??
    candidate.output ??
    candidate.chunk ??
    candidate.text ??
    candidate.message ??
    null;

  if (typeof rawChunk !== "string") {
    return null;
  }

  return { stream, chunk: rawChunk };
}

class VercelSandboxDriverFactory implements SandboxDriverFactory {
  readonly #runtime: string;
  readonly #defaultTimeout: number;

  constructor(options: VercelSandboxOptions = {}) {
    this.#runtime = options.runtime ?? "node24";
    this.#defaultTimeout = normalizeSandboxTimeout(
      options.defaultTimeout ?? options.timeout,
      "Vercel sandbox default timeout",
    );
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
    const timeout = this.#defaultTimeoutForCreate(options);

    const sandbox = await Sandbox.create({
      runtime: this.#runtime,
      timeout,
      ports: options.exposedPorts,
      networkPolicy: compileVercelNetworkPolicy(options.policy),
    });

    return new VercelSandboxDriver(sandbox);
  }

  async resumeSandbox(
    workspace: WorkspaceRecord,
    snapshot: PersistedSandboxState,
    options: SandboxCreateOptions,
  ): Promise<SandboxDriver> {
    const timeout = this.#defaultTimeoutForCreate(options);
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
            timeout,
            ports: options.exposedPorts,
            networkPolicy: compileVercelNetworkPolicy(options.policy),
          });

    // Reattaching to an existing live sandbox should not mutate provider state.
    // Updating the network policy here races with commit/snapshot shutdown and can
    // fail on otherwise read-only flows like getActiveLease().
    return new VercelSandboxDriver(sandbox);
  }

  #defaultTimeoutForCreate(options: SandboxCreateOptions): number {
    return normalizeSandboxTimeout(options.timeoutMs ?? this.#defaultTimeout, "runtime timeout");
  }
}

function normalizeSandboxTimeout(value: unknown, label: string): number {
  if (value === undefined) {
    return 60_000;
  }

  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    !Number.isFinite(value) ||
    value <= 0
  ) {
    throw new Error(`${label} must be a positive integer in milliseconds.`);
  }

  return value;
}

export function createVercelSandboxDriverFactory(
  options: VercelSandboxOptions = {},
): SandboxDriverFactory {
  return new VercelSandboxDriverFactory(options);
}
