CREATE TABLE `montage_job` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`room_id` text NOT NULL,
	`sidecar_upload_id` text NOT NULL,
	`state` text NOT NULL,
	`etape` text,
	`pourcent` integer DEFAULT 0 NOT NULL,
	`worker_id` text,
	`lease_until` text,
	`pas_avant` text,
	`tentatives` integer DEFAULT 0 NOT NULL,
	`output_key` text,
	`s3_upload_id` text,
	`duration_ms` integer,
	`marques_manquantes` text,
	`erreur` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`finished_at` text
);
--> statement-breakpoint
CREATE INDEX `montage_job_state_idx` ON `montage_job` (`state`,`pas_avant`);--> statement-breakpoint
CREATE INDEX `montage_job_session_idx` ON `montage_job` (`session_id`);--> statement-breakpoint
CREATE TABLE `montage_worker` (
	`id` text PRIMARY KEY NOT NULL,
	`nom` text NOT NULL,
	`token_hash` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	`last_seen_at` text,
	`revoked_at` text
);
