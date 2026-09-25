ALTER TABLE `comment` ADD `author_subtitle` text;--> statement-breakpoint
ALTER TABLE `comment` ADD `avatar` text;--> statement-breakpoint
ALTER TABLE `comment` ADD `image` text;--> statement-breakpoint
ALTER TABLE `comment` ADD `permalink` text;--> statement-breakpoint
ALTER TABLE `comment` ADD `network` text;--> statement-breakpoint
ALTER TABLE `comment` ADD `posted_at` text;--> statement-breakpoint
ALTER TABLE `comment` ADD `featured` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `comment` ADD `source_pinned` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `comment` ADD `source_active` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `comment` ADD `sponsor_name` text;--> statement-breakpoint
ALTER TABLE `comment` ADD `sponsor_logo` text;--> statement-breakpoint
ALTER TABLE `comment` ADD `updated_at` text;--> statement-breakpoint
CREATE INDEX `comment_screen_idx` ON `comment` (`status`,`source_active`,`seq`);