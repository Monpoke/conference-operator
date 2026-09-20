CREATE TABLE `session_consent` (
	`session_id` text PRIMARY KEY NOT NULL,
	`statut` text NOT NULL,
	`decide_a` text NOT NULL,
	`room_id` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
