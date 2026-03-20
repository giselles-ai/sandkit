export type SandkitDialect = "sqlite" | "postgresql" | "mysql";

export type SandkitColumnType = "text" | "integer" | "boolean" | "json" | "timestamp";

export interface SandkitColumn {
  name: string;
  type: SandkitColumnType;
  nullable?: boolean;
  primaryKey?: boolean;
  unique?: boolean;
  defaultValue?: string | number | boolean | null;
  comment?: string;
  references?: {
    table: string;
    field: string;
  };
}

export interface SandkitIndex {
  name: string;
  columns: string[];
  unique?: boolean;
}

export interface SandkitTable {
  name: string;
  schema?: string;
  comment?: string;
  exportName?: string;
  columns: SandkitColumn[];
  indexes?: SandkitIndex[];
}

export interface SandkitSchemaModel {
  name: string;
  version: number;
  dialect: SandkitDialect;
  tables: SandkitTable[];
}

const nowIso = () => new Date().toISOString();

const baseSchemaName = "sandkit";
const tablePrefix = "sandkit_";

export const sandkitWorkspaceExport = "sandkitWorkspaces";
export const sandkitRunExport = "sandkitRuns";
export const sandkitPolicyExport = "sandkitPolicies";

export const sandkitWorkspaceTable: SandkitTable = {
  name: `${tablePrefix}workspaces`,
  exportName: sandkitWorkspaceExport,
  comment: "Persistent workspace metadata.",
  columns: [
    {
      name: "id",
      type: "text",
      primaryKey: true,
      nullable: false,
      comment: "Workspace identifier.",
    },
    {
      name: "metadata",
      type: "json",
      nullable: true,
      comment: "Durable workspace metadata, including sandbox lifecycle state.",
    },
    {
      name: "sandboxId",
      type: "text",
      nullable: true,
      comment: "Stable id returned by the sandbox provider.",
    },
    { name: "status", type: "text", nullable: false },
    { name: "name", type: "text", nullable: true },
    {
      name: "lastResumedAt",
      type: "timestamp",
      nullable: true,
      comment: "Most recent point when Sandkit resolved a concrete sandbox session.",
    },
    { name: "createdAt", type: "timestamp", nullable: false },
    { name: "updatedAt", type: "timestamp", nullable: false },
  ],
  indexes: [{ name: "workspaces_status_idx", columns: ["status"] }],
};

export const sandkitRunTable: SandkitTable = {
  name: `${tablePrefix}runs`,
  exportName: sandkitRunExport,
  comment: "Execution facts for unit-of-work runs.",
  columns: [
    {
      name: "id",
      type: "text",
      primaryKey: true,
      nullable: false,
      comment: "Run identifier.",
    },
    {
      name: "workspace_id",
      type: "text",
      nullable: false,
      comment: "FK to workspace.",
      references: {
        table: sandkitWorkspaceTable.name,
        field: "id",
      },
    },
    { name: "command", type: "text", nullable: false },
    {
      name: "args",
      type: "json",
      nullable: true,
      comment: "Arguments for the executed command.",
    },
    {
      name: "provider",
      type: "text",
      nullable: false,
      comment: "Driver identity used for execution (e.g. vercel-sandbox, mock).",
    },
    {
      name: "execution_target_id",
      type: "text",
      nullable: false,
      comment: "Driver execution target used by the command run.",
    },
    {
      name: "status",
      type: "text",
      nullable: false,
      comment: "Unit status.",
    },
    {
      name: "policy_snapshot_id",
      type: "text",
      nullable: true,
      comment: "FK to policy snapshot row.",
    },
    {
      name: "provider_commit",
      type: "json",
      nullable: true,
      comment: "Provider durability metadata at run completion.",
    },
    { name: "exit_code", type: "integer", nullable: true },
    { name: "stdout", type: "text", nullable: true },
    { name: "stderr", type: "text", nullable: true },
    { name: "started_at", type: "timestamp", nullable: false },
    { name: "finished_at", type: "timestamp", nullable: true },
  ],
  indexes: [
    { name: "runs_workspace_id_idx", columns: ["workspace_id"] },
    { name: "runs_finished_at_idx", columns: ["finished_at"] },
    { name: "runs_status_idx", columns: ["status"] },
  ],
};

export const sandkitPolicyTable: SandkitTable = {
  name: `${tablePrefix}policies`,
  exportName: sandkitPolicyExport,
  comment: "Network policy snapshots and source of truth.",
  columns: [
    {
      name: "id",
      type: "text",
      primaryKey: true,
      nullable: false,
    },
    {
      name: "workspace_id",
      type: "text",
      nullable: false,
      comment: "FK to workspace.",
      references: {
        table: sandkitWorkspaceTable.name,
        field: "id",
      },
    },
    { name: "policy_id", type: "text", nullable: false },
    { name: "config", type: "json", nullable: false },
    { name: "created_at", type: "timestamp", nullable: false },
  ],
  indexes: [{ name: "policies_workspace_id_idx", columns: ["workspace_id"] }],
};

export function createSandkitSchemaModel(dialect: SandkitDialect = "sqlite"): SandkitSchemaModel {
  const schemaName = dialect === "postgresql" ? `${baseSchemaName}_schema` : baseSchemaName;
  return {
    name: schemaName,
    version: 2,
    dialect,
    tables: [
      {
        ...sandkitWorkspaceTable,
        schema: dialect === "postgresql" ? "public" : undefined,
      },
      {
        ...sandkitRunTable,
        schema: dialect === "postgresql" ? "public" : undefined,
      },
      {
        ...sandkitPolicyTable,
        schema: dialect === "postgresql" ? "public" : undefined,
      },
    ],
  };
}

export function createModelSnapshot(dialect: SandkitDialect = "sqlite"): {
  model: SandkitSchemaModel;
  generatedAt: string;
} {
  return {
    model: createSandkitSchemaModel(dialect),
    generatedAt: nowIso(),
  };
}
