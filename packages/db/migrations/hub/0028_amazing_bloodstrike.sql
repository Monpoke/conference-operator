CREATE TABLE `video_partage` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text,
	`mot_de_passe_hash` text NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL
);
