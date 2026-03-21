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
