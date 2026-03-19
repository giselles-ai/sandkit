import type { WorkspaceRecord } from "../types.ts";
import type { SandkitContext } from "./context.ts";
import { ManagedSandbox } from "./sandbox.ts";
import { readPersistedSandboxState, writePersistedSandboxState } from "./workspace-state.ts";

export class WorkspaceHandle {
  readonly #ctx: SandkitContext;
  #record: WorkspaceRecord;

  constructor(ctx: SandkitContext, record: WorkspaceRecord) {
    this.#ctx = ctx;
    this.#record = record;
  }

  get id(): string {
    return this.#record.id;
  }

  get record(): WorkspaceRecord {
    return this.#record;
  }

  async createOrResumeSandbox(): Promise<ManagedSandbox> {
    const persistedSandbox = readPersistedSandboxState(this.#record);
    const sandbox = persistedSandbox
      ? await this.#ctx.driverFactory.resumeSandbox(this.#record, persistedSandbox)
      : await this.#ctx.driverFactory.createSandbox(this.#record);

    const snapshot = await sandbox.snapshot();
    this.#record = await this.#ctx.adapter.workspaces.updateWorkspace(this.#record.id, {
      lastResumedAt: new Date().toISOString(),
      metadata: writePersistedSandboxState(this.#record, snapshot),
      sandboxId: snapshot.sessionId,
    });

    return new ManagedSandbox(this.#ctx, this.#record, sandbox, (record) => {
      this.#record = record;
    });
  }
}
