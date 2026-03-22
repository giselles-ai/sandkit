import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { sandkitWorkspaces } from "./sandkit";

export const openclawSessions = sqliteTable("openclaw_sessions", {
  id: text("id").notNull().primaryKey(),
  workspace_id: text("workspace_id")
    .notNull()
    .references(() => sandkitWorkspaces.id),
  sandbox_id: text("sandbox_id"),
  phase: text("phase").notNull(),
  install_spec: text("install_spec").notNull(),
  public_url: text("public_url"),
  last_healthy_at: integer("last_healthy_at", { mode: "timestamp_ms" }),
  error_code: text("error_code"),
  error_message: text("error_message"),
  started_at: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  updated_at: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  finished_at: integer("finished_at", { mode: "timestamp_ms" }),
});
