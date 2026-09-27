ALTER TYPE "public"."top_shape" ADD VALUE IF NOT EXISTS 'custom';
--> statement-breakpoint
ALTER TABLE "design_layers" ADD COLUMN "outline" jsonb;
--> statement-breakpoint
ALTER TABLE "design_layers" ADD CONSTRAINT "design_layers_outline_matches_shape" CHECK (
  (("shape"::text = 'custom'
    AND "outline" IS NOT NULL
    AND jsonb_typeof("outline") = 'object'
    AND "outline"->'version' = '1'::jsonb
    AND jsonb_typeof("outline"->'vertices') = 'array'
    AND CASE WHEN jsonb_typeof("outline"->'vertices') = 'array'
      THEN jsonb_array_length("outline"->'vertices') BETWEEN 3 AND 256
      ELSE false END
    AND "outline"->'mirror' IN ('"none"'::jsonb, '"leftRight"'::jsonb, '"topBottom"'::jsonb, '4'::jsonb, '6'::jsonb, '8'::jsonb, '12'::jsonb))
  OR ("shape"::text <> 'custom' AND "outline" IS NULL)) IS TRUE
);
