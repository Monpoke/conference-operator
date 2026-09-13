CREATE TABLE `integration` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`url` text NOT NULL,
	`secret` text,
	`niveau_technique` text DEFAULT 'essentiel' NOT NULL,
	`niveau_exploitation` text DEFAULT 'essentiel' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`last_sent_at` text,
	`last_error_at` text,
	`last_error` text
);
