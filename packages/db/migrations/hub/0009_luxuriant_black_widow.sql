CREATE TABLE `asset` (
	`sha256` text PRIMARY KEY NOT NULL,
	`source_url` text NOT NULL,
	`content_type` text,
	`byte_size` integer,
	`downloaded_at` text,
	`failed_at` text,
	`failure_reason` text
);
--> statement-breakpoint
CREATE INDEX `asset_source_idx` ON `asset` (`source_url`);