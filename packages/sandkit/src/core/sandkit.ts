import type { SandkitOptions, WorkspaceCreateInput } from "../types.ts";
import { createSandkitContext, type SandkitContext } from "./context.ts";
import { asWorkspacePolicyMetadata } from "./workspace-policy.ts";
import { type PublicWorkspaceHandle, WorkspaceHandle } from "./workspace.ts";

export class Sandkit {
  readonly #ctx: SandkitContext;

  constructor(options: SandkitOptions = {}) {
    this.#ctx = createSandkitContext(options);
  }

  get context(): SandkitContext {
    return this.#ctx;
  }

  async createWorkspace(input: WorkspaceCreateInput = {}): Promise<PublicWorkspaceHandle> {
    const policy = input.policy ?? this.#ctx.defaultPolicy;
    const workspace = await this.#ctx.adapter.workspaces.createWorkspace({
      ...input,
      metadata: {
        ...input.metadata,
        ...asWorkspacePolicyMetadata(policy),
      },
    });
    return new WorkspaceHandle(this.#ctx, workspace);
  }

  async getWorkspace(id: string): Promise<PublicWorkspaceHandle> {
    const workspace = await this.#ctx.adapter.workspaces.getWorkspace(id);
    if (!workspace) {
      throw new Error(`Workspace not found: ${id}`);
    }

    return new WorkspaceHandle(this.#ctx, workspace);
  }
}

export function sandkit(options: SandkitOptions = {}): Sandkit {
  return new Sandkit(options);
}
