ALTER TABLE `montage_job` ADD `phase` text DEFAULT 'analyse' NOT NULL;--> statement-breakpoint
ALTER TABLE `montage_job` ADD `analyse_json` text;--> statement-breakpoint
ALTER TABLE `montage_job` ADD `coupe_json` text;--> statement-breakpoint
ALTER TABLE `montage_job` ADD `validee_par` text;--> statement-breakpoint
ALTER TABLE `montage_job` ADD `audio_json` text;