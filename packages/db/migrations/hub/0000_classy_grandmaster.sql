CREATE TABLE `command` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`room_id` text,
	`type` text NOT NULL,
	`payload_json` text NOT NULL,
	`ttl_seconds` integer,
	`issued_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `room`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `command_room_idx` ON `command` (`room_id`,`seq`);--> statement-breakpoint
CREATE TABLE `comment` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`source` text NOT NULL,
	`author` text NOT NULL,
	`author_handle` text,
	`external_id` text,
	`text` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`room_id` text,
	`session_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`moderated_at` text,
	`moderated_by` text,
	FOREIGN KEY (`room_id`) REFERENCES `room`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `comment_id_idx` ON `comment` (`id`);--> statement-breakpoint
CREATE INDEX `comment_status_idx` ON `comment` (`status`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `comment_source_external_idx` ON `comment` (`source`,`external_id`);--> statement-breakpoint
CREATE TABLE `device_request` (
	`client_id` text PRIMARY KEY NOT NULL,
	`scope` text,
	`requested_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `hub_setting` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ingest_event` (
	`room_id` text NOT NULL,
	`id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`delivery` text NOT NULL,
	`occurred_at` text NOT NULL,
	`monotonic_ms` integer NOT NULL,
	`payload_json` text NOT NULL,
	`received_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`room_id`, `id`),
	FOREIGN KEY (`room_id`) REFERENCES `room`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ingest_event_room_seq_idx` ON `ingest_event` (`room_id`,`seq`);--> statement-breakpoint
CREATE INDEX `ingest_event_type_idx` ON `ingest_event` (`type`);--> statement-breakpoint
CREATE TABLE `program_snapshot` (
	`content_hash` text PRIMARY KEY NOT NULL,
	`source_url` text NOT NULL,
	`raw_json` text NOT NULL,
	`program_json` text NOT NULL,
	`session_count` integer NOT NULL,
	`issue_count` integer NOT NULL,
	`imported_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`active` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `question` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`session_id` text,
	`author` text,
	`text` text NOT NULL,
	`votes` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `room`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `question_room_status_idx` ON `question` (`room_id`,`status`);--> statement-breakpoint
CREATE TABLE `question_vote` (
	`question_id` text NOT NULL,
	`device_id` text NOT NULL,
	`voted_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`question_id`, `device_id`),
	FOREIGN KEY (`question_id`) REFERENCES `question`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `room` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`track_id` text NOT NULL,
	`config_json` text NOT NULL,
	`stream_key_enc` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `room_track_idx` ON `room` (`track_id`);--> statement-breakpoint
CREATE TABLE `room_device` (
	`client_id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`label` text,
	`approved_by_user_id` text,
	`approved_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`last_seen_at` text,
	`revoked_at` text,
	FOREIGN KEY (`room_id`) REFERENCES `room`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `room_device_room_idx` ON `room_device` (`room_id`);--> statement-breakpoint
CREATE TABLE `room_state` (
	`room_id` text PRIMARY KEY NOT NULL,
	`connectivity` text DEFAULT 'OFFLINE' NOT NULL,
	`last_seen_at` text,
	`scene_role` text,
	`current_session_id` text,
	`recording` integer DEFAULT false NOT NULL,
	`streaming` integer DEFAULT false NOT NULL,
	`outbox_depth` integer DEFAULT 0 NOT NULL,
	`program_content_hash` text,
	`last_seq` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `room`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `session_override` (
	`session_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`delay_minutes` integer,
	`note` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session_state` (
	`session_id` text PRIMARY KEY NOT NULL,
	`room_id` text,
	`status` text NOT NULL,
	`started_at` text,
	`ended_at` text,
	`decided_by` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `room`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `session_state_room_idx` ON `session_state` (`room_id`,`status`);