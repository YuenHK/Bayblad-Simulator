ALTER TABLE "admin_reauth_grants" DROP CONSTRAINT "admin_reauth_grants_time_order";--> statement-breakpoint
ALTER TABLE "admin_audit" DROP CONSTRAINT "admin_audit_admin_session_id_admin_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "admin_audit" DROP CONSTRAINT "admin_audit_admin_user_id_admin_users_id_fk";
--> statement-breakpoint
ALTER TABLE "admin_audit" ADD CONSTRAINT "admin_audit_admin_user_id_admin_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_reauth_grants" ADD CONSTRAINT "admin_reauth_grants_time_order" CHECK ("admin_reauth_grants"."expires_at" > "admin_reauth_grants"."created_at" and ("admin_reauth_grants"."consumed_at" is null or ("admin_reauth_grants"."consumed_at" >= "admin_reauth_grants"."created_at" and "admin_reauth_grants"."consumed_at" <= "admin_reauth_grants"."expires_at")));--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_archive_requires_revoke" CHECK ("admin_sessions"."archived_at" is null or "admin_sessions"."revoked_at" is not null);