// This file is generated from Sandkit schema model.
// Provider: sqlite
// Version: 2

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

type WorkspaceMetadata = {
  [key: string]: unknown;
};

export const sandkitWorkspaces = sqliteTable("sandkit_workspaces", {
  id: text("id").notNull().primaryKey(),
  metadata: text("metadata", { mode: "json" }).$type<WorkspaceMetadata | null>(),
  sandboxId: text("sandboxId"),
  status: text("status").notNull(),
  name: text("name"),
  lastResumedAt: integer("lastResumedAt", { mode: "timestamp_ms" }),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
});

export const sandkitRuns = sqliteTable("sandkit_runs", {
  id: text("id").notNull().primaryKey(),
  workspace_id: text("workspace_id")
    .notNull()
    .references(() => sandkitWorkspaces.id),
  command: text("command").notNull(),
  args: text("args", { mode: "json" }),
  provider: text("provider").notNull(),
  execution_target_id: text("execution_target_id").notNull(),
  status: text("status").notNull(),
  policy_snapshot_id: text("policy_snapshot_id"),
  provider_commit: text("provider_commit", { mode: "json" }),
  exit_code: integer("exit_code"),
  stdout: text("stdout"),
  stderr: text("stderr"),
  started_at: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  finished_at: integer("finished_at", { mode: "timestamp_ms" }),
});

export const sandkitPolicies = sqliteTable("sandkit_policies", {
  id: text("id").notNull().primaryKey(),
  workspace_id: text("workspace_id")
    .notNull()
    .references(() => sandkitWorkspaces.id),
  policy_id: text("policy_id").notNull(),
  config: text("config", { mode: "json" }).notNull(),
  created_at: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const sandkitSchema = {
  sandkitWorkspaces,
  sandkitRuns,
  sandkitPolicies,
};
