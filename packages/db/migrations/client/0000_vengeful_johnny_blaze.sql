CREATE TABLE `applied_command` (
	`seq` integer PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`applied_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `asset_cache` (
	`sha256` text PRIMARY KEY NOT NULL,
	`source_url` text NOT NULL,
	`content_type` text,
	`byte_size` integer NOT NULL,
	`downloaded_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `asset_cache_source_idx` ON `asset_cache` (`source_url`);--> statement-breakpoint
CREATE TABLE `journal` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`level` text NOT NULL,
	`message` text NOT NULL,
	`context_json` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `journal_created_idx` ON `journal` (`created_at`);--> statement-breakpoint
CREATE TABLE `outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`delivery` text NOT NULL,
	`payload_json` text NOT NULL,
	`occurred_at` text NOT NULL,
	`monotonic_ms` integer NOT NULL,
	`dedup_key` text,
	`expires_at` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`last_error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `outbox_ready_idx` ON `outbox` (`next_attempt_at`,`seq`);--> statement-breakpoint
CREATE INDEX `outbox_delivery_idx` ON `outbox` (`delivery`,`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `outbox_dedup_idx` ON `outbox` (`room_id`,`dedup_key`);--> statement-breakpoint
CREATE TABLE `program_cache` (
	`content_hash` text PRIMARY KEY NOT NULL,
	`program_json` text NOT NULL,
	`synced_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`active` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `room_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`room_id` text,
	`token` text,
	`config_json` text,
	`active_content_hash` text,
	`next_seq` integer DEFAULT 1 NOT NULL,
	`last_command_seq` integer DEFAULT 0 NOT NULL,
	`clock_offset_ms` integer DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
