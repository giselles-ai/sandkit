CREATE TABLE `merge_readiness_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`pr_url` text NOT NULL,
	`pr_title` text,
	`pr_repo` text,
	`pr_owner` text,
	`pr_number` integer,
	`status` text NOT NULL,
	`verdict` text,
	`recommendation` text,
	`evidence` text,
	`questions` text,
	`next_actions` text,
	`confidence` integer,
	`error_message` text,
	`output_path` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `sandkit_workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `merge_readiness_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`review_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`sandbox_id` text,
	`process_id` text,
	`status` text NOT NULL,
	`command` text,
	`stdout_path` text,
	`stderr_path` text,
	`result_path` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `merge_readiness_reviews`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `sandkit_workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
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
CREATE TABLE `sandkit_setup_states` (
	`id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
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
