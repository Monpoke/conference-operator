CREATE TABLE `youtube_envoi` (
	`job_id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`video_id` text,
	`octets` integer DEFAULT 0 NOT NULL,
	`taille` integer,
	`erreur` text,
	`updated_at` text NOT NULL
);
