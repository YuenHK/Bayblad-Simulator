ALTER TABLE "rounds" RENAME COLUMN "result_fingerprint" TO "input_fingerprint";--> statement-breakpoint
ALTER TABLE "rounds" DROP CONSTRAINT "rounds_result_fingerprint_format";--> statement-breakpoint
DROP INDEX "rounds_result_fingerprint_uidx";--> statement-breakpoint
DROP INDEX "rounds_match_number_idx";--> statement-breakpoint
ALTER TABLE "rounds" ADD COLUMN "external_round_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "rounds" ADD COLUMN "authority_key_hash" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "room_participants_active_player_seat_uidx" ON "room_participants" USING btree ("room_id","role") WHERE "room_participants"."left_at" is null and "room_participants"."role" in ('player1', 'player2');--> statement-breakpoint
CREATE UNIQUE INDEX "rounds_authority_key_hash_uidx" ON "rounds" USING btree ("authority_key_hash");--> statement-breakpoint
CREATE INDEX "rounds_input_fingerprint_idx" ON "rounds" USING btree ("input_fingerprint");--> statement-breakpoint
ALTER TABLE "designs" ADD CONSTRAINT "designs_model_versions_nonblank" CHECK (length(btrim("designs"."schema_version")) > 0 and length(btrim("designs"."performance_model_version")) > 0);--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_model_versions_nonblank" CHECK (length(btrim("matches"."performance_model_version")) > 0 and length(btrim("matches"."physics_model_version")) > 0);--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_protocol_version_positive" CHECK ("matches"."protocol_version" > 0);--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_external_round_id_format" CHECK (length("rounds"."external_round_id") between 1 and 128 and "rounds"."external_round_id" ~ '^[A-Za-z0-9_-]+$');--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_authority_key_hash_format" CHECK ("rounds"."authority_key_hash" ~ '^[a-f0-9]{64}$');--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_input_fingerprint_format" CHECK ("rounds"."input_fingerprint" ~ '^[a-f0-9]{64}$');--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_physics_model_version_nonblank" CHECK (length(btrim("rounds"."physics_model_version")) > 0);