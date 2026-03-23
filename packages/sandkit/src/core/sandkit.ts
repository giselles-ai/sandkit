import type { SandkitOptions, WorkspaceCreateInput } from "../types.ts";
import { createSandkitContext, type SandkitContext } from "./context.ts";
import { asWorkspacePolicyMetadata, removeWorkspacePolicyMetadata } from "./workspace-policy.ts";
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
    const { policy, metadata, ...rest } = input;
    const sanitizedMetadata = removeWorkspacePolicyMetadata(metadata);
    const workspaceMetadata = policy
      ? {
          ...sanitizedMetadata,
          ...asWorkspacePolicyMetadata(policy),
        }
      : sanitizedMetadata;

    const workspace = await this.#ctx.adapter.workspaces.createWorkspace({
      ...rest,
      metadata: workspaceMetadata,
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
