CREATE TYPE "public"."admin_login_scope" AS ENUM('account', 'client', 'global');--> statement-breakpoint
CREATE TABLE "admin_login_limits" (
	"scope" "admin_login_scope" NOT NULL,
	"key_hash" text NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"locked_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_login_limits_scope_key_hash_pk" PRIMARY KEY("scope","key_hash"),
	CONSTRAINT "admin_login_limits_hash_format" CHECK ("admin_login_limits"."key_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "admin_login_limits_count_nonnegative" CHECK ("admin_login_limits"."failure_count" >= 0),
	CONSTRAINT "admin_login_limits_lock_order" CHECK ("admin_login_limits"."locked_until" is null or "admin_login_limits"."locked_until" >= "admin_login_limits"."window_start")
);
--> statement-breakpoint
CREATE TABLE "admin_reauth_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"admin_session_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"purpose" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "admin_reauth_grants_hash_format" CHECK ("admin_reauth_grants"."token_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "admin_reauth_grants_purpose_nonblank" CHECK (length(btrim("admin_reauth_grants"."purpose")) between 1 and 64),
	CONSTRAINT "admin_reauth_grants_time_order" CHECK ("admin_reauth_grants"."expires_at" > "admin_reauth_grants"."created_at" and ("admin_reauth_grants"."consumed_at" is null or "admin_reauth_grants"."consumed_at" >= "admin_reauth_grants"."created_at"))
);
--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin_reauth_grants" ADD CONSTRAINT "admin_reauth_grants_admin_user_id_admin_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_reauth_grants" ADD CONSTRAINT "admin_reauth_grants_admin_session_id_admin_sessions_id_fk" FOREIGN KEY ("admin_session_id") REFERENCES "public"."admin_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_login_limits_updated_idx" ON "admin_login_limits" USING btree ("updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_reauth_grants_token_uidx" ON "admin_reauth_grants" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "admin_reauth_grants_expiry_idx" ON "admin_reauth_grants" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "admin_sessions_active_idx" ON "admin_sessions" USING btree ("admin_user_id","expires_at","archived_at");
--> statement-breakpoint
CREATE FUNCTION admin_audit_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'admin_audit is append-only' USING ERRCODE = '55000'; END $$;
--> statement-breakpoint
CREATE TRIGGER admin_audit_append_only BEFORE UPDATE OR DELETE ON admin_audit FOR EACH ROW EXECUTE FUNCTION admin_audit_append_only_guard();
--> statement-breakpoint
CREATE TRIGGER admin_audit_no_truncate BEFORE TRUNCATE ON admin_audit FOR EACH STATEMENT EXECUTE FUNCTION admin_audit_append_only_guard();
