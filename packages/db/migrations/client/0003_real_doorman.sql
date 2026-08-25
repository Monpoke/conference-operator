CREATE TABLE `televersement` (
	`file` text PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'rush' NOT NULL,
	`session_id` text,
	`taille_octets` integer DEFAULT 0 NOT NULL,
	`object_key` text,
	`s3_upload_id` text,
	`taille_part_octets` integer,
	`parts_json` text DEFAULT '[]' NOT NULL,
	`octets_envoyes` integer DEFAULT 0 NOT NULL,
	`state` text DEFAULT 'attente' NOT NULL,
	`manuel` integer DEFAULT false NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`debit_octets_s` integer,
	`next_attempt_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`demande_a` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`commence_a` text,
	`fini_a` text
);
--> statement-breakpoint
CREATE INDEX `televersement_pret_idx` ON `televersement` (`state`,`next_attempt_at`);