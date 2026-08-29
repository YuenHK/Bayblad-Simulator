-- Pre-first-deploy baseline. Future deployed changes require forward migrations.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";--> statement-breakpoint
CREATE TYPE "public"."audit_outcome" AS ENUM('success', 'failure', 'denied');--> statement-breakpoint
CREATE TYPE "public"."battle_outcome" AS ENUM('player1', 'player2', 'draw');--> statement-breakpoint
CREATE TYPE "public"."battle_reason" AS ENUM('stopped', 'out-of-bounds', 'timeout', 'simultaneous');--> statement-breakpoint
CREATE TYPE "public"."deletion_scope" AS ENUM('identity', 'class', 'date_range', 'all');--> statement-breakpoint
CREATE TYPE "public"."identity_link_reason" AS ENUM('verified_cookie_and_iclass', 'admin_correction');--> statement-breakpoint
CREATE TYPE "public"."identity_status" AS ENUM('iclass', 'cookie', 'guest');--> statement-breakpoint
CREATE TYPE "public"."launch_grade" AS ENUM('Perfect', 'Great', 'Good', 'Miss');--> statement-breakpoint
CREATE TYPE "public"."match_status" AS ENUM('in_progress', 'completed', 'persist_failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."metal_disc_placement" AS ENUM('under_bottom');--> statement-breakpoint
CREATE TYPE "public"."participant_role" AS ENUM('player1', 'player2', 'spectator');--> statement-breakpoint
CREATE TYPE "public"."player_slot" AS ENUM('player1', 'player2');--> statement-breakpoint
CREATE TYPE "public"."room_status" AS ENUM('waiting', 'launch', 'battle', 'result', 'closed');--> statement-breakpoint
CREATE TYPE "public"."top_layer_position" AS ENUM('top', 'middle', 'bottom');--> statement-breakpoint
CREATE TYPE "public"."top_shape" AS ENUM('circle', 'polygon', 'star', 'wave');--> statement-breakpoint
CREATE TABLE "admin_audit" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"admin_user_id" uuid,
	"admin_session_id" uuid,
	"action" varchar(128) NOT NULL,
	"target_type" varchar(64),
	"target_id" varchar(128),
	"outcome" "audit_outcome" NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_ip" "inet",
	"user_agent" varchar(512),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"csrf_token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_ip" "inet",
	"user_agent" varchar(512),
	CONSTRAINT "admin_sessions_token_hash_format" CHECK ("admin_sessions"."token_hash" ~ '^[a-f0-9]{64}$' and "admin_sessions"."csrf_token_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "admin_sessions_expiry_after_creation" CHECK ("admin_sessions"."expires_at" > "admin_sessions"."created_at")
);
--> statement-breakpoint
CREATE TABLE "admin_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" varchar(80) NOT NULL,
	"password_hash" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "admin_users_username_nonblank" CHECK (length(btrim("admin_users"."username")) between 1 and 80)
);
--> statement-breakpoint
CREATE TABLE "deletion_audit" (
	"id" uuid PRIMARY KEY NOT NULL,
	"admin_user_id" uuid,
	"scope" "deletion_scope" NOT NULL,
	"filter_hash" text NOT NULL,
	"preview_count" integer NOT NULL,
	"deleted_identity_count" integer NOT NULL,
	"deleted_design_count" integer NOT NULL,
	"deleted_match_count" integer NOT NULL,
	"transaction_id" bigint DEFAULT txid_current() NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deletion_audit_filter_hash_format" CHECK ("deletion_audit"."filter_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "deletion_audit_counts_nonnegative" CHECK ("deletion_audit"."preview_count" >= 0 and "deletion_audit"."deleted_identity_count" >= 0 and "deletion_audit"."deleted_design_count" >= 0 and "deletion_audit"."deleted_match_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "design_layers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"design_id" uuid NOT NULL,
	"source_layer_id" varchar(128) NOT NULL,
	"layer_order" smallint NOT NULL,
	"position" "top_layer_position" NOT NULL,
	"shape" "top_shape" NOT NULL,
	"points" smallint NOT NULL,
	"diameter_mm" numeric(7, 3) NOT NULL,
	"corner_roundness" numeric(5, 4) NOT NULL,
	"rotation_deg" numeric(7, 3) NOT NULL,
	"color" varchar(7) NOT NULL,
	CONSTRAINT "design_layers_order_range" CHECK ("design_layers"."layer_order" between 0 and 2),
	CONSTRAINT "design_layers_position_matches_order" CHECK (("design_layers"."layer_order" = 0 and "design_layers"."position" = 'top') or ("design_layers"."layer_order" = 1 and "design_layers"."position" = 'middle') or ("design_layers"."layer_order" = 2 and "design_layers"."position" = 'bottom')),
	CONSTRAINT "design_layers_points_range" CHECK ("design_layers"."points" between 3 and 16),
	CONSTRAINT "design_layers_diameter_range" CHECK ("design_layers"."diameter_mm" between 20 and 80),
	CONSTRAINT "design_layers_roundness_range" CHECK ("design_layers"."corner_roundness" between 0 and 1),
	CONSTRAINT "design_layers_rotation_range" CHECK ("design_layers"."rotation_deg" >= 0 and "design_layers"."rotation_deg" < 360),
	CONSTRAINT "design_layers_color_format" CHECK ("design_layers"."color" ~ '^#[0-9A-Fa-f]{6}$')
);
--> statement-breakpoint
CREATE TABLE "designs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"logical_design_id" uuid NOT NULL,
	"owner_identity_id" uuid,
	"version" integer NOT NULL,
	"schema_version" varchar(64) NOT NULL,
	"name" varchar(40) NOT NULL,
	"screw_count" smallint NOT NULL,
	"screw_radius_mm" numeric(7, 3) NOT NULL,
	"screw_rotation_deg" numeric(7, 3) NOT NULL,
	"metal_disc_diameter_mm" numeric(7, 3) NOT NULL,
	"metal_disc_placement" "metal_disc_placement" DEFAULT 'under_bottom' NOT NULL,
	"total_mass_g" numeric(10, 4) NOT NULL,
	"polar_moment_gmm2" numeric(16, 4) NOT NULL,
	"center_of_mass_x_mm" numeric(10, 5) NOT NULL,
	"center_of_mass_y_mm" numeric(10, 5) NOT NULL,
	"performance_speed" numeric(7, 3) NOT NULL,
	"performance_spin_duration" numeric(7, 3) NOT NULL,
	"performance_stability" numeric(7, 3) NOT NULL,
	"performance_impact_resistance" numeric(7, 3) NOT NULL,
	"performance_model_version" varchar(64) NOT NULL,
	"battle_eligible" boolean DEFAULT false NOT NULL,
	"validation_issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "designs_version_positive" CHECK ("designs"."version" > 0),
	CONSTRAINT "designs_screw_count_range" CHECK ("designs"."screw_count" between 3 and 8),
	CONSTRAINT "designs_screw_radius_range" CHECK ("designs"."screw_radius_mm" between 5 and 25),
	CONSTRAINT "designs_screw_rotation_range" CHECK ("designs"."screw_rotation_deg" >= 0 and "designs"."screw_rotation_deg" < 360),
	CONSTRAINT "designs_metal_disc_range" CHECK ("designs"."metal_disc_diameter_mm" = 0 or "designs"."metal_disc_diameter_mm" between 10 and 55),
	CONSTRAINT "designs_metal_disc_placement" CHECK ("designs"."metal_disc_placement" = 'under_bottom'),
	CONSTRAINT "designs_physics_values_positive" CHECK ("designs"."total_mass_g" > 0 and "designs"."total_mass_g" <= 60 and "designs"."polar_moment_gmm2" > 0),
	CONSTRAINT "designs_performance_range" CHECK ("designs"."performance_speed" between 0 and 100 and "designs"."performance_spin_duration" between 0 and 100 and "designs"."performance_stability" between 0 and 100 and "designs"."performance_impact_resistance" between 0 and 100),
	CONSTRAINT "designs_battle_eligibility_consistent" CHECK (jsonb_typeof("designs"."validation_issues") = 'array' and (not "designs"."battle_eligible" or jsonb_array_length("designs"."validation_issues") = 0)),
	CONSTRAINT "designs_model_versions_nonblank" CHECK (length(btrim("designs"."schema_version")) > 0 and length(btrim("designs"."performance_model_version")) > 0)
);
--> statement-breakpoint
CREATE TABLE "identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "identity_status" NOT NULL,
	"display_name" varchar(80) NOT NULL,
	"student_name" varchar(80),
	"class_name" varchar(30),
	"student_number" varchar(30),
	"device_name" varchar(128),
	"anonymous_device_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"iclass_external_id" varchar(128),
	"external_device_id" varchar(128),
	"merged_into_identity_id" uuid,
	"merged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identities_merge_fields_consistent" CHECK (("identities"."merged_into_identity_id" is null and "identities"."merged_at" is null) or ("identities"."merged_into_identity_id" is not null and "identities"."merged_at" is not null and "identities"."merged_into_identity_id" <> "identities"."id"))
);
--> statement-breakpoint
CREATE TABLE "identity_links" (
	"source_identity_id" uuid NOT NULL,
	"target_identity_id" uuid NOT NULL,
	"reason" "identity_link_reason" NOT NULL,
	"verification_fingerprint" text NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_links_source_identity_id_target_identity_id_pk" PRIMARY KEY("source_identity_id","target_identity_id"),
	CONSTRAINT "identity_links_distinct_identities" CHECK ("identity_links"."source_identity_id" <> "identity_links"."target_identity_id"),
	CONSTRAINT "identity_links_fingerprint_format" CHECK ("identity_links"."verification_fingerprint" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "identity_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identity_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"last_ip" "inet",
	"user_agent" varchar(512),
	CONSTRAINT "identity_sessions_token_hash_format" CHECK ("identity_sessions"."token_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "identity_sessions_expiry_after_creation" CHECK ("identity_sessions"."expires_at" > "identity_sessions"."created_at")
);
--> statement-breakpoint
CREATE TABLE "webclip_token_nonces" (
	"jti_hash" text PRIMARY KEY NOT NULL,
	"device_id" varchar(128) NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"attempt_hash" text,
	"result_identity_id" uuid,
	"result_session_id" uuid,
	"result_token_hash" text,
	"committed_at" timestamp with time zone,
	CONSTRAINT "webclip_token_nonces_jti_hash_format" CHECK ("webclip_token_nonces"."jti_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "webclip_token_nonces_expiry_after_issue" CHECK ("webclip_token_nonces"."expires_at" > "webclip_token_nonces"."issued_at"),
	CONSTRAINT "webclip_token_nonces_result_consistent" CHECK (("webclip_token_nonces"."used_at" is null and "webclip_token_nonces"."attempt_hash" is null and "webclip_token_nonces"."result_identity_id" is null and "webclip_token_nonces"."result_session_id" is null and "webclip_token_nonces"."result_token_hash" is null and "webclip_token_nonces"."committed_at" is null) or ("webclip_token_nonces"."used_at" is not null and "webclip_token_nonces"."attempt_hash" ~ '^[a-f0-9]{64}$' and "webclip_token_nonces"."result_identity_id" is not null and "webclip_token_nonces"."result_session_id" is not null and "webclip_token_nonces"."result_token_hash" ~ '^[a-f0-9]{64}$' and "webclip_token_nonces"."committed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"room_id" uuid,
	"idempotency_fingerprint" text NOT NULL,
	"status" "match_status" DEFAULT 'in_progress' NOT NULL,
	"player1_identity_id" uuid,
	"player2_identity_id" uuid,
	"player1_design_id" uuid NOT NULL,
	"player2_design_id" uuid NOT NULL,
	"player1_battle_points" smallint,
	"player2_battle_points" smallint,
	"player1_challenge_points" numeric(4, 3),
	"player2_challenge_points" numeric(4, 3),
	"player1_total" numeric(5, 3),
	"player2_total" numeric(5, 3),
	"winner" "player_slot",
	"round_winners" jsonb,
	"performance_model_version" varchar(64) NOT NULL,
	"physics_model_version" varchar(64) NOT NULL,
	"protocol_version" smallint NOT NULL,
	"spectator_count" integer DEFAULT 0 NOT NULL,
	"player1_ip" "inet",
	"player2_ip" "inet",
	"player1_user_agent" varchar(512),
	"player2_user_agent" varchar(512),
	"player1_device_name" varchar(128),
	"player2_device_name" varchar(128),
	"persist_failure_code" varchar(128),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "matches_idempotency_fingerprint_format" CHECK ("matches"."idempotency_fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "matches_spectator_count_nonnegative" CHECK ("matches"."spectator_count" >= 0),
	CONSTRAINT "matches_distinct_player_identities" CHECK ("matches"."player1_identity_id" is null or "matches"."player2_identity_id" is null or "matches"."player1_identity_id" <> "matches"."player2_identity_id"),
	CONSTRAINT "matches_challenge_points_range" CHECK (("matches"."player1_challenge_points" is null or "matches"."player1_challenge_points" between 0 and 0.5) and ("matches"."player2_challenge_points" is null or "matches"."player2_challenge_points" between 0 and 0.5)),
	CONSTRAINT "matches_battle_points_range" CHECK (("matches"."player1_battle_points" is null or "matches"."player1_battle_points" between 0 and 2) and ("matches"."player2_battle_points" is null or "matches"."player2_battle_points" between 0 and 2)),
	CONSTRAINT "matches_round_winners_shape" CHECK ("matches"."round_winners" is null or (jsonb_typeof("matches"."round_winners") = 'array' and jsonb_array_length("matches"."round_winners") between 2 and 3 and "matches"."round_winners" <@ '["player1","player2"]'::jsonb)),
	CONSTRAINT "matches_completed_score_shape" CHECK ("matches"."status" <> 'completed' or ("matches"."completed_at" is not null and "matches"."winner" is not null and "matches"."player1_battle_points" is not null and "matches"."player2_battle_points" is not null and "matches"."player1_challenge_points" is not null and "matches"."player2_challenge_points" is not null and "matches"."player1_total" is not null and "matches"."player2_total" is not null and "matches"."round_winners" is not null and jsonb_typeof("matches"."round_winners") = 'array' and (("matches"."winner" = 'player1' and "matches"."player1_battle_points" = 2 and "matches"."player2_battle_points" = 0 and "matches"."round_winners" = '["player1","player1"]'::jsonb) or ("matches"."winner" = 'player1' and "matches"."player1_battle_points" = 2 and "matches"."player2_battle_points" = 1 and "matches"."round_winners" in ('["player1","player2","player1"]'::jsonb, '["player2","player1","player1"]'::jsonb)) or ("matches"."winner" = 'player2' and "matches"."player2_battle_points" = 2 and "matches"."player1_battle_points" = 0 and "matches"."round_winners" = '["player2","player2"]'::jsonb) or ("matches"."winner" = 'player2' and "matches"."player2_battle_points" = 2 and "matches"."player1_battle_points" = 1 and "matches"."round_winners" in ('["player1","player2","player2"]'::jsonb, '["player2","player1","player2"]'::jsonb))))),
	CONSTRAINT "matches_totals_consistent" CHECK (("matches"."player1_total" is null and "matches"."player1_battle_points" is null and "matches"."player1_challenge_points" is null or "matches"."player1_total" = "matches"."player1_battle_points" + "matches"."player1_challenge_points") and ("matches"."player2_total" is null and "matches"."player2_battle_points" is null and "matches"."player2_challenge_points" is null or "matches"."player2_total" = "matches"."player2_battle_points" + "matches"."player2_challenge_points")),
	CONSTRAINT "matches_completed_time_order" CHECK ("matches"."completed_at" is null or "matches"."completed_at" >= "matches"."started_at"),
	CONSTRAINT "matches_model_versions_nonblank" CHECK (length(btrim("matches"."performance_model_version")) > 0 and length(btrim("matches"."physics_model_version")) > 0),
	CONSTRAINT "matches_protocol_version_positive" CHECK ("matches"."protocol_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "room_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"identity_id" uuid,
	"participant_public_id" varchar(32) NOT NULL,
	"display_name_snapshot" varchar(80) NOT NULL,
	"role" "participant_role" NOT NULL,
	"is_owner" boolean DEFAULT false NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	"last_ip" "inet",
	"user_agent" varchar(512),
	"device_name_snapshot" varchar(128),
	CONSTRAINT "room_participants_time_order" CHECK ("room_participants"."left_at" is null or "room_participants"."left_at" >= "room_participants"."joined_at")
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(32) NOT NULL,
	"name" varchar(30) NOT NULL,
	"owner_identity_id" uuid,
	"status" "room_status" DEFAULT 'waiting' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_battle_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	CONSTRAINT "rooms_closed_status_consistent" CHECK ("rooms"."closed_at" is null or "rooms"."status" = 'closed')
);
--> statement-breakpoint
CREATE TABLE "rounds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"match_id" uuid NOT NULL,
	"external_round_id" varchar(128) NOT NULL,
	"authority_key_hash" text NOT NULL,
	"round_number" smallint NOT NULL,
	"attempt" smallint NOT NULL,
	"seed" bigint NOT NULL,
	"outcome" "battle_outcome" NOT NULL,
	"outcome_reason" "battle_reason" NOT NULL,
	"ticks" integer NOT NULL,
	"launch_grade_a" "launch_grade" NOT NULL,
	"launch_grade_b" "launch_grade" NOT NULL,
	"launch_angular_multiplier_a" numeric(6, 4) NOT NULL,
	"launch_angular_multiplier_b" numeric(6, 4) NOT NULL,
	"launch_linear_multiplier_a" numeric(6, 4) NOT NULL,
	"launch_linear_multiplier_b" numeric(6, 4) NOT NULL,
	"physics_model_version" varchar(64) NOT NULL,
	"input_fingerprint" text NOT NULL,
	"battle_result_json" jsonb NOT NULL,
	"frames_strategy" varchar(32) DEFAULT 'full_json_v1' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rounds_number_range" CHECK ("rounds"."round_number" between 1 and 3),
	CONSTRAINT "rounds_attempt_positive" CHECK ("rounds"."attempt" > 0),
	CONSTRAINT "rounds_ticks_nonnegative" CHECK ("rounds"."ticks" >= 0 and "rounds"."ticks" <= 5400),
	CONSTRAINT "rounds_seed_safe_integer" CHECK ("rounds"."seed" between -9007199254740991 and 9007199254740991),
	CONSTRAINT "rounds_launch_multiplier_range" CHECK ("rounds"."launch_angular_multiplier_a" between 0 and 2 and "rounds"."launch_angular_multiplier_b" between 0 and 2 and "rounds"."launch_linear_multiplier_a" between 0 and 2 and "rounds"."launch_linear_multiplier_b" between 0 and 2),
	CONSTRAINT "rounds_external_round_id_format" CHECK (length("rounds"."external_round_id") between 1 and 128 and "rounds"."external_round_id" ~ '^[A-Za-z0-9_-]+$'),
	CONSTRAINT "rounds_authority_key_hash_format" CHECK ("rounds"."authority_key_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "rounds_input_fingerprint_format" CHECK ("rounds"."input_fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "rounds_frames_strategy" CHECK ("rounds"."frames_strategy" in ('full_json_v1', 'summary_v1')),
	CONSTRAINT "rounds_time_order" CHECK ("rounds"."completed_at" >= "rounds"."started_at"),
	CONSTRAINT "rounds_physics_model_version_nonblank" CHECK (length(btrim("rounds"."physics_model_version")) > 0),
	CONSTRAINT "rounds_battle_result_shape" CHECK (jsonb_typeof("rounds"."battle_result_json") = 'object' and "rounds"."battle_result_json" ?& array['modelVersion','seed','ticks','frames','outcome','finalStats'] and jsonb_typeof("rounds"."battle_result_json"->'modelVersion') = 'string' and length(btrim("rounds"."battle_result_json"->>'modelVersion')) > 0 and "rounds"."battle_result_json"->>'modelVersion' = "rounds"."physics_model_version" and jsonb_typeof("rounds"."battle_result_json"->'seed') = 'number' and ("rounds"."battle_result_json"->>'seed')::numeric = trunc(("rounds"."battle_result_json"->>'seed')::numeric) and ("rounds"."battle_result_json"->>'seed')::numeric between -9007199254740991 and 9007199254740991 and ("rounds"."battle_result_json"->>'seed')::numeric = "rounds"."seed"::numeric and jsonb_typeof("rounds"."battle_result_json"->'ticks') = 'number' and ("rounds"."battle_result_json"->>'ticks')::numeric = trunc(("rounds"."battle_result_json"->>'ticks')::numeric) and ("rounds"."battle_result_json"->>'ticks')::numeric between 0 and 5400 and ("rounds"."battle_result_json"->>'ticks')::numeric = "rounds"."ticks"::numeric and jsonb_typeof("rounds"."battle_result_json"->'frames') = 'array' and jsonb_typeof("rounds"."battle_result_json"->'finalStats') = 'object' and jsonb_typeof("rounds"."battle_result_json"->'outcome') = 'object' and "rounds"."battle_result_json"->'outcome' ?& array['winner','reason'] and "rounds"."battle_result_json"->'outcome'->>'winner' = "rounds"."outcome"::text and "rounds"."battle_result_json"->'outcome'->>'reason' = "rounds"."outcome_reason"::text)
);
--> statement-breakpoint
ALTER TABLE "admin_audit" ADD CONSTRAINT "admin_audit_admin_user_id_admin_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_audit" ADD CONSTRAINT "admin_audit_admin_session_id_admin_sessions_id_fk" FOREIGN KEY ("admin_session_id") REFERENCES "public"."admin_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_admin_user_id_admin_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deletion_audit" ADD CONSTRAINT "deletion_audit_admin_user_id_admin_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_layers" ADD CONSTRAINT "design_layers_design_id_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."designs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "designs" ADD CONSTRAINT "designs_owner_identity_id_identities_id_fk" FOREIGN KEY ("owner_identity_id") REFERENCES "public"."identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identities" ADD CONSTRAINT "identities_merged_into_identity_id_identities_id_fk" FOREIGN KEY ("merged_into_identity_id") REFERENCES "public"."identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_links" ADD CONSTRAINT "identity_links_source_identity_id_identities_id_fk" FOREIGN KEY ("source_identity_id") REFERENCES "public"."identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_links" ADD CONSTRAINT "identity_links_target_identity_id_identities_id_fk" FOREIGN KEY ("target_identity_id") REFERENCES "public"."identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_sessions" ADD CONSTRAINT "identity_sessions_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webclip_token_nonces" ADD CONSTRAINT "webclip_token_nonces_result_identity_id_identities_id_fk" FOREIGN KEY ("result_identity_id") REFERENCES "public"."identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webclip_token_nonces" ADD CONSTRAINT "webclip_token_nonces_result_session_id_identity_sessions_id_fk" FOREIGN KEY ("result_session_id") REFERENCES "public"."identity_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_player1_identity_id_identities_id_fk" FOREIGN KEY ("player1_identity_id") REFERENCES "public"."identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_player2_identity_id_identities_id_fk" FOREIGN KEY ("player2_identity_id") REFERENCES "public"."identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_player1_design_id_designs_id_fk" FOREIGN KEY ("player1_design_id") REFERENCES "public"."designs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_player2_design_id_designs_id_fk" FOREIGN KEY ("player2_design_id") REFERENCES "public"."designs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_participants" ADD CONSTRAINT "room_participants_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_participants" ADD CONSTRAINT "room_participants_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_owner_identity_id_identities_id_fk" FOREIGN KEY ("owner_identity_id") REFERENCES "public"."identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_audit_created_at_idx" ON "admin_audit" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "admin_audit_admin_action_idx" ON "admin_audit" USING btree ("admin_user_id","action","created_at");--> statement-breakpoint
CREATE INDEX "admin_audit_target_idx" ON "admin_audit" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_sessions_token_hash_uidx" ON "admin_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "admin_sessions_admin_last_seen_idx" ON "admin_sessions" USING btree ("admin_user_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "admin_sessions_expires_at_idx" ON "admin_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_users_username_lower_uidx" ON "admin_users" USING btree (lower("username"));--> statement-breakpoint
CREATE INDEX "deletion_audit_completed_at_idx" ON "deletion_audit" USING btree ("completed_at");--> statement-breakpoint
CREATE INDEX "deletion_audit_admin_completed_idx" ON "deletion_audit" USING btree ("admin_user_id","completed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "design_layers_design_order_uidx" ON "design_layers" USING btree ("design_id","layer_order");--> statement-breakpoint
CREATE UNIQUE INDEX "design_layers_design_position_uidx" ON "design_layers" USING btree ("design_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "design_layers_design_source_id_uidx" ON "design_layers" USING btree ("design_id","source_layer_id");--> statement-breakpoint
CREATE INDEX "design_layers_parameter_analytics_idx" ON "design_layers" USING btree ("shape","points","diameter_mm","corner_roundness");--> statement-breakpoint
CREATE UNIQUE INDEX "designs_logical_version_uidx" ON "designs" USING btree ("logical_design_id","version");--> statement-breakpoint
CREATE INDEX "designs_owner_created_at_idx" ON "designs" USING btree ("owner_identity_id","created_at");--> statement-breakpoint
CREATE INDEX "designs_performance_model_idx" ON "designs" USING btree ("performance_model_version","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "identities_anonymous_device_id_uidx" ON "identities" USING btree ("anonymous_device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "identities_iclass_external_id_uidx" ON "identities" USING btree ("iclass_external_id") WHERE "identities"."iclass_external_id" is not null;--> statement-breakpoint
CREATE INDEX "identities_class_student_idx" ON "identities" USING btree ("class_name","student_number");--> statement-breakpoint
CREATE INDEX "identities_status_last_seen_idx" ON "identities" USING btree ("status","last_seen_at");--> statement-breakpoint
CREATE INDEX "identities_merged_into_idx" ON "identities" USING btree ("merged_into_identity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_links_source_uidx" ON "identity_links" USING btree ("source_identity_id");--> statement-breakpoint
CREATE INDEX "identity_links_target_idx" ON "identity_links" USING btree ("target_identity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_sessions_token_hash_uidx" ON "identity_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "identity_sessions_identity_last_seen_idx" ON "identity_sessions" USING btree ("identity_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "identity_sessions_active_expires_at_idx" ON "identity_sessions" USING btree ("expires_at") WHERE "identity_sessions"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "webclip_token_nonces_expiry_idx" ON "webclip_token_nonces" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "matches_idempotency_fingerprint_uidx" ON "matches" USING btree ("idempotency_fingerprint");--> statement-breakpoint
CREATE INDEX "matches_completed_at_idx" ON "matches" USING btree ("completed_at");--> statement-breakpoint
CREATE INDEX "matches_status_completed_at_idx" ON "matches" USING btree ("status","completed_at");--> statement-breakpoint
CREATE INDEX "matches_player1_identity_idx" ON "matches" USING btree ("player1_identity_id","completed_at");--> statement-breakpoint
CREATE INDEX "matches_player2_identity_idx" ON "matches" USING btree ("player2_identity_id","completed_at");--> statement-breakpoint
CREATE INDEX "matches_model_versions_idx" ON "matches" USING btree ("performance_model_version","physics_model_version","completed_at");--> statement-breakpoint
CREATE INDEX "matches_room_started_at_idx" ON "matches" USING btree ("room_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "room_participants_room_public_id_uidx" ON "room_participants" USING btree ("room_id","participant_public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "room_participants_active_player_seat_uidx" ON "room_participants" USING btree ("room_id","role") WHERE "room_participants"."left_at" is null and "room_participants"."role" in ('player1', 'player2');--> statement-breakpoint
CREATE INDEX "room_participants_identity_joined_idx" ON "room_participants" USING btree ("identity_id","joined_at");--> statement-breakpoint
CREATE INDEX "room_participants_room_joined_idx" ON "room_participants" USING btree ("room_id","joined_at");--> statement-breakpoint
CREATE UNIQUE INDEX "rooms_code_active_uidx" ON "rooms" USING btree ("code") WHERE "rooms"."closed_at" is null;--> statement-breakpoint
CREATE INDEX "rooms_created_at_idx" ON "rooms" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "rooms_status_created_at_idx" ON "rooms" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "rooms_owner_created_at_idx" ON "rooms" USING btree ("owner_identity_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "rounds_match_round_attempt_uidx" ON "rounds" USING btree ("match_id","round_number","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "rounds_match_external_round_id_uidx" ON "rounds" USING btree ("match_id","external_round_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rounds_authority_key_hash_uidx" ON "rounds" USING btree ("authority_key_hash");--> statement-breakpoint
CREATE INDEX "rounds_input_fingerprint_idx" ON "rounds" USING btree ("input_fingerprint");--> statement-breakpoint
CREATE INDEX "rounds_completed_at_idx" ON "rounds" USING btree ("completed_at");--> statement-breakpoint
CREATE INDEX "rounds_launch_grades_idx" ON "rounds" USING btree ("launch_grade_a","launch_grade_b","completed_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "set_row_updated_at"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "identities_set_updated_at" BEFORE UPDATE ON "identities"
FOR EACH ROW EXECUTE FUNCTION "set_row_updated_at"();--> statement-breakpoint
CREATE TRIGGER "admin_users_set_updated_at" BEFORE UPDATE ON "admin_users"
FOR EACH ROW EXECUTE FUNCTION "set_row_updated_at"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "steam_top_assert_battle_eligible_design_layers"(checked_design_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE eligible boolean; layer_count integer; position_count integer;
BEGIN
  SELECT battle_eligible INTO eligible FROM designs WHERE id = checked_design_id;
  IF eligible IS DISTINCT FROM true THEN RETURN; END IF;
  SELECT count(*), count(DISTINCT position) INTO layer_count, position_count
  FROM design_layers WHERE design_id = checked_design_id;
  IF layer_count <> 3 OR position_count <> 3 OR NOT EXISTS (
    SELECT 1 FROM design_layers WHERE design_id = checked_design_id
    GROUP BY design_id HAVING count(*) FILTER (WHERE position = 'top') = 1
      AND count(*) FILTER (WHERE position = 'middle') = 1
      AND count(*) FILTER (WHERE position = 'bottom') = 1
  ) THEN
    RAISE EXCEPTION 'Battle-eligible design % must have exactly top, middle and bottom layers', checked_design_id
      USING ERRCODE = '23514', CONSTRAINT = 'designs_battle_eligible_three_layers';
  END IF;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "steam_top_check_design_layer_topology"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'designs' THEN
    PERFORM steam_top_assert_battle_eligible_design_layers(COALESCE(NEW.id, OLD.id));
  ELSE
    IF TG_OP <> 'INSERT' THEN
      PERFORM steam_top_assert_battle_eligible_design_layers(OLD.design_id);
    END IF;
    IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR NEW.design_id IS DISTINCT FROM OLD.design_id) THEN
      PERFORM steam_top_assert_battle_eligible_design_layers(NEW.design_id);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "designs_battle_eligible_three_layers"
AFTER INSERT OR UPDATE OF battle_eligible ON "designs" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "steam_top_check_design_layer_topology"();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "design_layers_battle_eligible_three_layers"
AFTER INSERT OR UPDATE OR DELETE ON "design_layers" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "steam_top_check_design_layer_topology"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "steam_top_check_round_authority_key"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_hash text;
BEGIN
  expected_hash := encode(digest(
    length(NEW.match_id::text)::text || ':' || NEW.match_id::text ||
    length(NEW.external_round_id)::text || ':' || NEW.external_round_id,
    'sha256'), 'hex');
  IF NEW.authority_key_hash <> expected_hash THEN
    RAISE EXCEPTION 'authority_key_hash does not match the canonical BattleEngine correlation key'
      USING ERRCODE = '23514', CONSTRAINT = 'rounds_authority_key_matches_correlation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "rounds_authority_key_matches_correlation"
BEFORE INSERT OR UPDATE OF match_id, external_round_id, authority_key_hash ON "rounds"
FOR EACH ROW EXECUTE FUNCTION "steam_top_check_round_authority_key"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "steam_top_current_delete_is_audited"()
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE configured_id text;
BEGIN
  configured_id := current_setting('steam_top.deletion_audit_id', true);
  IF configured_id IS NULL OR configured_id !~
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM deletion_audit
    WHERE id = configured_id::uuid
      AND transaction_id = txid_current()
      AND admin_user_id IS NOT NULL
  );
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "steam_top_protect_eligible_design"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND steam_top_current_delete_is_audited() THEN RETURN OLD; END IF;
  IF OLD.battle_eligible THEN
    RAISE EXCEPTION 'Battle-eligible design snapshots are immutable'
      USING ERRCODE = '55000', CONSTRAINT = 'eligible_designs_are_immutable';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;--> statement-breakpoint
CREATE TRIGGER "eligible_designs_are_immutable" BEFORE UPDATE OR DELETE ON "designs"
FOR EACH ROW EXECUTE FUNCTION "steam_top_protect_eligible_design"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "steam_top_protect_eligible_design_layer"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_eligible boolean := false; new_eligible boolean := false;
BEGIN
  IF TG_OP = 'DELETE' AND steam_top_current_delete_is_audited() THEN RETURN OLD; END IF;
  IF TG_OP <> 'INSERT' THEN SELECT battle_eligible INTO old_eligible FROM designs WHERE id = OLD.design_id; END IF;
  IF TG_OP <> 'DELETE' THEN SELECT battle_eligible INTO new_eligible FROM designs WHERE id = NEW.design_id; END IF;
  IF COALESCE(old_eligible, false) OR COALESCE(new_eligible, false) THEN
    RAISE EXCEPTION 'Layers of a battle-eligible design are immutable'
      USING ERRCODE = '55000', CONSTRAINT = 'eligible_design_layers_are_immutable';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;--> statement-breakpoint
CREATE TRIGGER "eligible_design_layers_are_immutable" BEFORE INSERT OR UPDATE OR DELETE ON "design_layers"
FOR EACH ROW EXECUTE FUNCTION "steam_top_protect_eligible_design_layer"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "steam_top_protect_completed_match"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND steam_top_current_delete_is_audited() THEN RETURN OLD; END IF;
  IF OLD.status = 'completed' THEN
    RAISE EXCEPTION 'Completed matches are immutable'
      USING ERRCODE = '55000', CONSTRAINT = 'completed_matches_are_immutable';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;--> statement-breakpoint
CREATE TRIGGER "completed_matches_are_immutable" BEFORE UPDATE OR DELETE ON "matches"
FOR EACH ROW EXECUTE FUNCTION "steam_top_protect_completed_match"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "steam_top_protect_authoritative_round"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND steam_top_current_delete_is_audited() THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Authoritative completed rounds are immutable'
    USING ERRCODE = '55000', CONSTRAINT = 'completed_rounds_are_immutable';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "completed_rounds_are_immutable" BEFORE UPDATE OR DELETE ON "rounds"
FOR EACH ROW EXECUTE FUNCTION "steam_top_protect_authoritative_round"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "steam_top_protect_deletion_audit"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Deletion audit records are immutable'
    USING ERRCODE = '55000', CONSTRAINT = 'deletion_audit_is_immutable';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "deletion_audit_is_immutable" BEFORE UPDATE OR DELETE ON "deletion_audit"
FOR EACH ROW EXECUTE FUNCTION "steam_top_protect_deletion_audit"();--> statement-breakpoint

COMMENT ON COLUMN "identities"."device_name" IS
  'Diagnostic context retained until explicit audited admin deletion or platform decommission; never an identity key.';--> statement-breakpoint
COMMENT ON COLUMN "identity_sessions"."last_ip" IS
  'Diagnostic context retained until explicit audited admin deletion or platform decommission; never an identity key.';--> statement-breakpoint
COMMENT ON COLUMN "room_participants"."last_ip" IS
  'Diagnostic context retained until explicit audited admin deletion or platform decommission; never an identity key.';--> statement-breakpoint
COMMENT ON COLUMN "matches"."player1_ip" IS
  'Diagnostic context retained until explicit audited admin deletion or platform decommission; never an identity key.';--> statement-breakpoint
COMMENT ON COLUMN "admin_sessions"."last_ip" IS
  'Diagnostic context retained until explicit audited admin deletion or platform decommission.';--> statement-breakpoint
COMMENT ON COLUMN "admin_audit"."request_ip" IS
  'Diagnostic context retained until explicit audited admin deletion or platform decommission.';
