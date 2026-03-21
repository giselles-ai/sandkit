import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sandkitWorkspaces = sqliteTable("sandkit_workspaces", {
  id: text("id").primaryKey(),
  metadata: text("metadata"),
  status: text("status").notNull(),
  sandboxId: text("sandboxId"),
  name: text("name"),
  lastResumedAt: text("lastResumedAt"),
  createdAt: text("createdAt").notNull(),
  updatedAt: text("updatedAt").notNull(),
});

export const sandkitRuns = sqliteTable("sandkit_runs", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull(),
  provider: text("provider").notNull(),
  execution_target_id: text("execution_target_id").notNull(),
  command: text("command").notNull(),
  args: text("args"),
  status: text("status").notNull(),
  policy_snapshot_id: text("policy_snapshot_id"),
  provider_commit: text("provider_commit"),
  exit_code: integer("exit_code"),
  stdout: text("stdout"),
  stderr: text("stderr"),
  started_at: text("started_at").notNull(),
  finished_at: text("finished_at"),
});

export const sandkitPolicies = sqliteTable("sandkit_policies", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull(),
  policy_id: text("policy_id").notNull(),
  config: text("config").notNull(),
  created_at: text("created_at").notNull(),
});
