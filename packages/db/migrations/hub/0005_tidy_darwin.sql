CREATE TABLE `session_feedback` (
	`session_id` text PRIMARY KEY NOT NULL,
	`feedback_id` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
