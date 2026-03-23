import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { sandkitWorkspaces } from "./sandkit";

export const triageRepositories = sqliteTable("triage_repositories", {
  id: text("id").notNull().primaryKey(),
  workspace_id: text("workspace_id")
    .notNull()
    .references(() => sandkitWorkspaces.id),
  slug: text("slug").notNull().unique(),
  default_branch: text("default_branch"),
  last_synced_at: integer("last_synced_at", { mode: "timestamp_ms" }),
  created_at: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updated_at: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const triageRuns = sqliteTable("triage_runs", {
  id: text("id").notNull().primaryKey(),
  tracked_repository_id: text("tracked_repository_id")
    .notNull()
    .references(() => triageRepositories.id),
  subject_type: text("subject_type").notNull(),
  subject_number: integer("subject_number").notNull(),
  status: text("status").notNull(),
  notes: text("notes"),
  report_path: text("report_path"),
  report_markdown: text("report_markdown"),
  error_message: text("error_message"),
  created_at: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updated_at: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  finished_at: integer("finished_at", { mode: "timestamp_ms" }),
});

export const triageSteps = sqliteTable("triage_steps", {
  id: text("id").notNull().primaryKey(),
  triage_run_id: text("triage_run_id")
    .notNull()
    .references(() => triageRuns.id),
  step_name: text("step_name").notNull(),
  status: text("status").notNull(),
  artifact_path: text("artifact_path"),
  command_exit_code: integer("command_exit_code"),
  command_stdout: text("command_stdout"),
  command_stderr: text("command_stderr"),
  started_at: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  finished_at: integer("finished_at", { mode: "timestamp_ms" }),
});
