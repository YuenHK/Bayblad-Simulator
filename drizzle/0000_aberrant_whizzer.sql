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
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"outcome" "audit_outcome" NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_ip" "inet",
	"user_agent" text,
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
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_ip" "inet",
	"user_agent" text,
	CONSTRAINT "admin_sessions_token_hash_format" CHECK ("admin_sessions"."token_hash" ~ '^[a-f0-9]{64}$' and "admin_sessions"."csrf_token_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "admin_sessions_expiry_after_creation" CHECK ("admin_sessions"."expires_at" > "admin_sessions"."created_at")
);
--> statement-breakpoint
CREATE TABLE "admin_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "admin_users_username_nonblank" CHECK (length(btrim("admin_users"."username")) between 1 and 80)
);
--> statement-breakpoint
CREATE TABLE "deletion_audit" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"admin_user_id" uuid,
	"scope" "deletion_scope" NOT NULL,
	"filter_hash" text NOT NULL,
	"preview_count" integer NOT NULL,
	"deleted_identity_count" integer NOT NULL,
	"deleted_design_count" integer NOT NULL,
	"deleted_match_count" integer NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deletion_audit_filter_hash_format" CHECK ("deletion_audit"."filter_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "deletion_audit_counts_nonnegative" CHECK ("deletion_audit"."preview_count" >= 0 and "deletion_audit"."deleted_identity_count" >= 0 and "deletion_audit"."deleted_design_count" >= 0 and "deletion_audit"."deleted_match_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "design_layers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"design_id" uuid NOT NULL,
	"source_layer_id" text NOT NULL,
	"layer_order" smallint NOT NULL,
	"position" "top_layer_position" NOT NULL,
	"shape" "top_shape" NOT NULL,
	"points" smallint NOT NULL,
	"diameter_mm" numeric(7, 3) NOT NULL,
	"corner_roundness" numeric(5, 4) NOT NULL,
	"rotation_deg" numeric(7, 3) NOT NULL,
	"color" text NOT NULL,
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
	"schema_version" text NOT NULL,
	"name" text NOT NULL,
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
	"performance_model_version" text NOT NULL,
	"canonical_json" jsonb NOT NULL,
	"performance_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "designs_version_positive" CHECK ("designs"."version" > 0),
	CONSTRAINT "designs_screw_count_range" CHECK ("designs"."screw_count" between 3 and 8),
	CONSTRAINT "designs_screw_radius_range" CHECK ("designs"."screw_radius_mm" between 5 and 25),
	CONSTRAINT "designs_screw_rotation_range" CHECK ("designs"."screw_rotation_deg" >= 0 and "designs"."screw_rotation_deg" < 360),
	CONSTRAINT "designs_metal_disc_range" CHECK ("designs"."metal_disc_diameter_mm" = 0 or "designs"."metal_disc_diameter_mm" between 10 and 55),
	CONSTRAINT "designs_metal_disc_placement" CHECK ("designs"."metal_disc_placement" = 'under_bottom'),
	CONSTRAINT "designs_physics_values_positive" CHECK ("designs"."total_mass_g" > 0 and "designs"."total_mass_g" <= 60 and "designs"."polar_moment_gmm2" > 0),
	CONSTRAINT "designs_performance_range" CHECK ("designs"."performance_speed" between 0 and 100 and "designs"."performance_spin_duration" between 0 and 100 and "designs"."performance_stability" between 0 and 100 and "designs"."performance_impact_resistance" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "identity_status" NOT NULL,
	"display_name" text NOT NULL,
	"student_name" text,
	"class_name" text,
	"student_number" text,
	"device_name" text,
	"anonymous_device_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"iclass_external_id" text,
	"external_device_id" text,
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
	"last_ip" "inet",
	"user_agent" text,
	CONSTRAINT "identity_sessions_token_hash_format" CHECK ("identity_sessions"."token_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "identity_sessions_expiry_after_creation" CHECK ("identity_sessions"."expires_at" > "identity_sessions"."created_at")
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
	"performance_model_version" text NOT NULL,
	"physics_model_version" text NOT NULL,
	"protocol_version" smallint NOT NULL,
	"spectator_count" integer DEFAULT 0 NOT NULL,
	"player1_ip" "inet",
	"player2_ip" "inet",
	"player1_user_agent" text,
	"player2_user_agent" text,
	"player1_device_name" text,
	"player2_device_name" text,
	"persist_failure_code" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "matches_idempotency_fingerprint_format" CHECK ("matches"."idempotency_fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "matches_spectator_count_nonnegative" CHECK ("matches"."spectator_count" >= 0),
	CONSTRAINT "matches_distinct_player_identities" CHECK ("matches"."player1_identity_id" is null or "matches"."player2_identity_id" is null or "matches"."player1_identity_id" <> "matches"."player2_identity_id"),
	CONSTRAINT "matches_challenge_points_range" CHECK (("matches"."player1_challenge_points" is null or "matches"."player1_challenge_points" between 0 and 0.5) and ("matches"."player2_challenge_points" is null or "matches"."player2_challenge_points" between 0 and 0.5)),
	CONSTRAINT "matches_completed_score_shape" CHECK ("matches"."status" <> 'completed' or ("matches"."completed_at" is not null and "matches"."winner" is not null and "matches"."player1_battle_points" is not null and "matches"."player2_battle_points" is not null and "matches"."player1_challenge_points" is not null and "matches"."player2_challenge_points" is not null and "matches"."player1_total" is not null and "matches"."player2_total" is not null and jsonb_array_length("matches"."round_winners") between 2 and 3 and (("matches"."player1_battle_points" = 2 and "matches"."player2_battle_points" in (0, 1) and "matches"."winner" = 'player1') or ("matches"."player2_battle_points" = 2 and "matches"."player1_battle_points" in (0, 1) and "matches"."winner" = 'player2')))),
	CONSTRAINT "matches_totals_consistent" CHECK (("matches"."player1_total" is null and "matches"."player1_battle_points" is null and "matches"."player1_challenge_points" is null or "matches"."player1_total" = "matches"."player1_battle_points" + "matches"."player1_challenge_points") and ("matches"."player2_total" is null and "matches"."player2_battle_points" is null and "matches"."player2_challenge_points" is null or "matches"."player2_total" = "matches"."player2_battle_points" + "matches"."player2_challenge_points")),
	CONSTRAINT "matches_completed_time_order" CHECK ("matches"."completed_at" is null or "matches"."completed_at" >= "matches"."started_at")
);
--> statement-breakpoint
CREATE TABLE "room_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"identity_id" uuid,
	"participant_public_id" text NOT NULL,
	"display_name_snapshot" text NOT NULL,
	"role" "participant_role" NOT NULL,
	"is_owner" boolean DEFAULT false NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	"last_ip" "inet",
	"user_agent" text,
	"device_name_snapshot" text,
	CONSTRAINT "room_participants_time_order" CHECK ("room_participants"."left_at" is null or "room_participants"."left_at" >= "room_participants"."joined_at")
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
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
	"physics_model_version" text NOT NULL,
	"result_fingerprint" text NOT NULL,
	"battle_result_json" jsonb NOT NULL,
	"frames_strategy" text DEFAULT 'full_json_v1' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rounds_number_range" CHECK ("rounds"."round_number" between 1 and 3),
	CONSTRAINT "rounds_attempt_positive" CHECK ("rounds"."attempt" > 0),
	CONSTRAINT "rounds_ticks_nonnegative" CHECK ("rounds"."ticks" >= 0 and "rounds"."ticks" <= 5400),
	CONSTRAINT "rounds_seed_safe_integer" CHECK ("rounds"."seed" between -9007199254740991 and 9007199254740991),
	CONSTRAINT "rounds_launch_multiplier_range" CHECK ("rounds"."launch_angular_multiplier_a" between 0 and 2 and "rounds"."launch_angular_multiplier_b" between 0 and 2 and "rounds"."launch_linear_multiplier_a" between 0 and 2 and "rounds"."launch_linear_multiplier_b" between 0 and 2),
	CONSTRAINT "rounds_result_fingerprint_format" CHECK ("rounds"."result_fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "rounds_frames_strategy" CHECK ("rounds"."frames_strategy" in ('full_json_v1', 'summary_v1')),
	CONSTRAINT "rounds_time_order" CHECK ("rounds"."completed_at" >= "rounds"."started_at")
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
CREATE INDEX "identity_sessions_expires_at_idx" ON "identity_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "matches_idempotency_fingerprint_uidx" ON "matches" USING btree ("idempotency_fingerprint");--> statement-breakpoint
CREATE INDEX "matches_completed_at_idx" ON "matches" USING btree ("completed_at");--> statement-breakpoint
CREATE INDEX "matches_status_completed_at_idx" ON "matches" USING btree ("status","completed_at");--> statement-breakpoint
CREATE INDEX "matches_player1_identity_idx" ON "matches" USING btree ("player1_identity_id","completed_at");--> statement-breakpoint
CREATE INDEX "matches_player2_identity_idx" ON "matches" USING btree ("player2_identity_id","completed_at");--> statement-breakpoint
CREATE INDEX "matches_model_versions_idx" ON "matches" USING btree ("performance_model_version","physics_model_version","completed_at");--> statement-breakpoint
CREATE INDEX "matches_room_started_at_idx" ON "matches" USING btree ("room_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "room_participants_room_public_id_uidx" ON "room_participants" USING btree ("room_id","participant_public_id");--> statement-breakpoint
CREATE INDEX "room_participants_identity_joined_idx" ON "room_participants" USING btree ("identity_id","joined_at");--> statement-breakpoint
CREATE INDEX "room_participants_room_joined_idx" ON "room_participants" USING btree ("room_id","joined_at");--> statement-breakpoint
CREATE UNIQUE INDEX "rooms_code_active_uidx" ON "rooms" USING btree ("code") WHERE "rooms"."closed_at" is null;--> statement-breakpoint
CREATE INDEX "rooms_created_at_idx" ON "rooms" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "rooms_status_created_at_idx" ON "rooms" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "rooms_owner_created_at_idx" ON "rooms" USING btree ("owner_identity_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "rounds_match_round_attempt_uidx" ON "rounds" USING btree ("match_id","round_number","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "rounds_result_fingerprint_uidx" ON "rounds" USING btree ("result_fingerprint");--> statement-breakpoint
CREATE INDEX "rounds_match_number_idx" ON "rounds" USING btree ("match_id","round_number","attempt");--> statement-breakpoint
CREATE INDEX "rounds_completed_at_idx" ON "rounds" USING btree ("completed_at");--> statement-breakpoint
CREATE INDEX "rounds_launch_grades_idx" ON "rounds" USING btree ("launch_grade_a","launch_grade_b","completed_at");