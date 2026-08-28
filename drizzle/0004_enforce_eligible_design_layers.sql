-- A battle-eligible snapshot is committed atomically with exactly three
-- canonical layers. DEFERRABLE allows the design row to be inserted before
-- its layer rows inside the same transaction.
CREATE FUNCTION "assert_battle_eligible_design_layers"("design_uuid" uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  "is_eligible" boolean;
  "layer_total" integer;
  "top_total" integer;
  "middle_total" integer;
  "bottom_total" integer;
BEGIN
  SELECT "battle_eligible"
    INTO "is_eligible"
    FROM "designs"
    WHERE "id" = $1;

  IF NOT FOUND OR NOT "is_eligible" THEN
    RETURN;
  END IF;

  SELECT
    count(*)::integer,
    count(*) FILTER (WHERE "position" = 'top')::integer,
    count(*) FILTER (WHERE "position" = 'middle')::integer,
    count(*) FILTER (WHERE "position" = 'bottom')::integer
  INTO "layer_total", "top_total", "middle_total", "bottom_total"
  FROM "design_layers"
  WHERE "design_id" = $1;

  IF "layer_total" <> 3
     OR "top_total" <> 1
     OR "middle_total" <> 1
     OR "bottom_total" <> 1 THEN
    RAISE EXCEPTION 'Battle-eligible design % must have exactly top, middle and bottom layers', "design_uuid"
      USING ERRCODE = '23514',
            CONSTRAINT = 'designs_battle_eligible_three_layers';
  END IF;
END;
$$;--> statement-breakpoint

CREATE FUNCTION "check_design_battle_layers_trigger"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM "assert_battle_eligible_design_layers"(NEW."id");
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE FUNCTION "check_design_layer_mutation_trigger"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM "assert_battle_eligible_design_layers"(OLD."design_id");
  END IF;
  IF TG_OP <> 'DELETE'
     AND (TG_OP = 'INSERT' OR NEW."design_id" IS DISTINCT FROM OLD."design_id") THEN
    PERFORM "assert_battle_eligible_design_layers"(NEW."design_id");
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "designs_battle_eligible_three_layers"
AFTER INSERT OR UPDATE ON "designs"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "check_design_battle_layers_trigger"();--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "design_layers_preserve_eligible_three_layers"
AFTER INSERT OR UPDATE OR DELETE ON "design_layers"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "check_design_layer_mutation_trigger"();
