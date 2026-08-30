CREATE SCHEMA IF NOT EXISTS restore_control;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS restore_control.finalize_outbox (
  nonce text PRIMARY KEY,
  restore_target_id uuid NOT NULL,
  app_role text NOT NULL,
  ledger_rows bigint NOT NULL,
  state text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
--> statement-breakpoint
DO $$ DECLARE legacy_name text; BEGIN
  SELECT conname INTO legacy_name
    FROM pg_constraint
   WHERE conrelid='restore_control.finalize_outbox'::regclass
     AND contype='c'
     AND regexp_replace(pg_get_constraintdef(oid),'\s+',' ','g') = 'CHECK ((state = ''committed''::text))';
  IF legacy_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE restore_control.finalize_outbox DROP CONSTRAINT %I',legacy_name);
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE restore_control.finalize_outbox
  ADD COLUMN IF NOT EXISTS deadline_at timestamptz,
  ADD COLUMN IF NOT EXISTS lease_owner text,
  ADD COLUMN IF NOT EXISTS lease_generation bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS system_identifier text,
  ADD COLUMN IF NOT EXISTS database_name text,
  ADD COLUMN IF NOT EXISTS ready_sha256 text,
  ADD COLUMN IF NOT EXISTS preflight_sha256 text,
  ADD COLUMN IF NOT EXISTS smoke_evidence jsonb,
  ADD COLUMN IF NOT EXISTS smoke_evidence_sha256 text,
  ADD COLUMN IF NOT EXISTS final_receipt jsonb,
  ADD COLUMN IF NOT EXISTS final_receipt_payload_b64 text,
  ADD COLUMN IF NOT EXISTS final_receipt_sha256 text,
  ADD COLUMN IF NOT EXISTS observed_at timestamptz,
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS aborted_at timestamptz;
--> statement-breakpoint
UPDATE restore_control.finalize_outbox SET state='legacy-committed' WHERE state='committed';
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='restore_control.finalize_outbox'::regclass AND conname='finalize_outbox_state_machine') THEN
    ALTER TABLE restore_control.finalize_outbox ADD CONSTRAINT finalize_outbox_state_machine CHECK (state IN ('legacy-committed','preflight-recorded','connect-granted-pending-smoke','smoke-observed','verified','aborted'));
  END IF;
END $$;
