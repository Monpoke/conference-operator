CREATE TABLE `youtube_vignette` (
	`cle` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`image` blob,
	`erreur` text,
	`updated_at` text NOT NULL
);
