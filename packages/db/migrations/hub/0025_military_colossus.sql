CREATE TABLE `comment_online_view` (
	`comment_id` text NOT NULL,
	`day` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`last_seen_at` text NOT NULL,
	PRIMARY KEY(`comment_id`, `day`)
);
