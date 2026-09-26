CREATE TABLE `room_pin` (
	`room_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`pinned_by` text NOT NULL,
	`pinned_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `room`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `session_slot` (
	`session_id` text PRIMARY KEY NOT NULL,
	`slot_of` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
