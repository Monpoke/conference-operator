CREATE TABLE `push_subscription` (
	`endpoint` text PRIMARY KEY NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`user_id` text,
	`label` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`last_pushed_at` text
);
