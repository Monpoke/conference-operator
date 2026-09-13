ALTER TABLE `room_state` ADD `obs_a_connected` integer;--> statement-breakpoint
ALTER TABLE `room_state` ADD `obs_b_connected` integer;--> statement-breakpoint
ALTER TABLE `room_state` ADD `obs_a_missing_roles` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `room_state` ADD `obs_b_missing_roles` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `room_state` ADD `stream_bitrate_kbps` integer;--> statement-breakpoint
ALTER TABLE `room_state` ADD `stream_skipped_ratio` real;--> statement-breakpoint
ALTER TABLE `room_state` ADD `stream_congestion` real;--> statement-breakpoint
ALTER TABLE `room_state` ADD `stream_health_at` text;