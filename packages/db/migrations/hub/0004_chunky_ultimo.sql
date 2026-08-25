CREATE TABLE `vod_upload` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`file` text NOT NULL,
	`kind` text NOT NULL,
	`session_id` text,
	`object_key` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`part_size_bytes` integer NOT NULL,
	`bytes_sent` integer DEFAULT 0 NOT NULL,
	`s3_upload_id` text,
	`parts_json` text DEFAULT '[]' NOT NULL,
	`state` text DEFAULT 'en-cours' NOT NULL,
	`debit_octets_s` integer,
	`started_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`last_progress_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`finished_at` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	FOREIGN KEY (`room_id`) REFERENCES `room`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vod_upload_room_file_idx` ON `vod_upload` (`room_id`,`file`);--> statement-breakpoint
CREATE INDEX `vod_upload_state_idx` ON `vod_upload` (`state`,`last_progress_at`);