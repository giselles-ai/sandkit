CREATE TABLE `openclaw_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`sandbox_id` text,
	`phase` text NOT NULL,
	`install_spec` text NOT NULL,
	`public_url` text,
	`last_healthy_at` integer,
	`error_code` text,
	`error_message` text,
	`started_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `sandkit_workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
