CREATE TABLE `comment_impression` (
	`comment_id` text NOT NULL,
	`room_id` text NOT NULL,
	`day` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`last_shown_at` text NOT NULL,
	PRIMARY KEY(`comment_id`, `room_id`, `day`)
);
--> statement-breakpoint
CREATE INDEX `comment_impression_comment_idx` ON `comment_impression` (`comment_id`);--> statement-breakpoint
ALTER TABLE `comment` ADD `sponsor_key` text;