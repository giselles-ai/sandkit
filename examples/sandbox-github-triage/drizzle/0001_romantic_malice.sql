CREATE TABLE `sandkit_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`policy_id` text NOT NULL,
	`config` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `sandkit_workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sandkit_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`command` text NOT NULL,
	`args` text,
	`provider` text NOT NULL,
	`execution_target_id` text NOT NULL,
	`status` text NOT NULL,
	`policy_snapshot_id` text,
	`provider_commit` text,
	`exit_code` integer,
	`stdout` text,
	`stderr` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `sandkit_workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sandkit_workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`metadata` text,
	`sandboxId` text,
	`status` text NOT NULL,
	`name` text,
	`lastResumedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `triage_repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`slug` text NOT NULL,
	`default_branch` text,
	`last_synced_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `sandkit_workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `triage_repositories_slug_unique` ON `triage_repositories` (`slug`);--> statement-breakpoint
CREATE TABLE `triage_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`tracked_repository_id` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_number` integer NOT NULL,
	`status` text NOT NULL,
	`notes` text,
	`report_path` text,
	`report_markdown` text,
	`error_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`tracked_repository_id`) REFERENCES `triage_repositories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `triage_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`triage_run_id` text NOT NULL,
	`step_name` text NOT NULL,
	`status` text NOT NULL,
	`artifact_path` text,
	`command_exit_code` integer,
	`command_stdout` text,
	`command_stderr` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`triage_run_id`) REFERENCES `triage_runs`(`id`) ON UPDATE no action ON DELETE no action
);
