import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { sandkitWorkspaces } from "./sandkit";

export const mergeReadinessReviews = sqliteTable("merge_readiness_reviews", {
  id: text("id").notNull().primaryKey(),
  workspace_id: text("workspace_id")
    .notNull()
    .references(() => sandkitWorkspaces.id),
  pr_url: text("pr_url").notNull(),
  pr_title: text("pr_title"),
  pr_repo: text("pr_repo"),
  pr_owner: text("pr_owner"),
  pr_number: integer("pr_number"),
  status: text("status").notNull(),
  verdict: text("verdict"),
  recommendation: text("recommendation"),
  evidence: text("evidence", { mode: "json" }),
  questions: text("questions", { mode: "json" }),
  next_actions: text("next_actions", { mode: "json" }),
  confidence: integer("confidence"),
  error_message: text("error_message"),
  output_path: text("output_path"),
  started_at: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  finished_at: integer("finished_at", { mode: "timestamp_ms" }),
  updated_at: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const mergeReadinessSessions = sqliteTable("merge_readiness_sessions", {
  id: text("id").notNull().primaryKey(),
  review_id: text("review_id")
    .notNull()
    .references(() => mergeReadinessReviews.id),
  workspace_id: text("workspace_id")
    .notNull()
    .references(() => sandkitWorkspaces.id),
  sandbox_id: text("sandbox_id"),
  process_id: text("process_id"),
  status: text("status").notNull(),
  command: text("command"),
  stdout_path: text("stdout_path"),
  stderr_path: text("stderr_path"),
  result_path: text("result_path"),
  started_at: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  finished_at: integer("finished_at", { mode: "timestamp_ms" }),
  updated_at: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
