CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`room_id` text,
	`detail` text,
	`ok` integer NOT NULL,
	`error` text,
	`command_seq` integer,
	`outcome_ok` integer,
	`outcome_message` text,
	`outcome_at` text
);
--> statement-breakpoint
CREATE INDEX `audit_log_at_idx` ON `audit_log` (`at`);--> statement-breakpoint
CREATE INDEX `audit_log_command_idx` ON `audit_log` (`command_seq`);