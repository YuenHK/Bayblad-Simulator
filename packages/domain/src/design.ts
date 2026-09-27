import { z } from "zod";
import { validateCustomOutline } from "./customOutline";

export const shapeSchema = z.enum(["circle", "polygon", "star", "wave", "custom"]);
export const outlineSchema = z.object({
  version: z.literal(1),
  vertices: z.array(z.object({ x: z.number().finite(), y: z.number().finite() })).min(3).max(256),
  mirror: z.union([z.enum(["none", "leftRight", "topBottom"]), z.literal(4), z.literal(6), z.literal(8), z.literal(12)]),
}).superRefine((outline, context) => {
  const result = validateCustomOutline(outline.vertices);
  if (!result.valid) context.addIssue({ code: "custom", path: ["vertices"], message: `Invalid custom outline: ${result.code}` });
});
export type CustomOutline = z.infer<typeof outlineSchema>;

// diameterMm is persisted as numeric(7,3). This numerical/round-trip allowance
// accepts its rounding (and floating-point noise), never scales the outline.
export const CUSTOM_DIAMETER_TOLERANCE_MM = 0.002;
const geometryFields = {
  shape: shapeSchema,
  points: z.number().int().min(3).max(16),
  diameterMm: z.number().min(20).max(80),
  cornerRoundness: z.number().min(0).max(1),
  rotationDeg: z.number().min(0).max(359),
  outline: outlineSchema.optional(),
};
export const geometryInputSchema = z.object(geometryFields).superRefine((input, context) => {
  if (input.shape !== "custom") {
    if (input.outline !== undefined) context.addIssue({ code: "custom", path: ["outline"], message: "Only custom layers may have an outline" });
    return;
  }
  if (input.outline === undefined) {
    context.addIssue({ code: "custom", path: ["outline"], message: "Custom layers require an outline" });
    return;
  }
  // Array size failures are continuable in Zod, so parent refinements may still
  // run. Do not calculate derived geometry for a child already outside bounds.
  // Invalid point structures abort the child parse before this refinement.
  const vertices = input.outline.vertices;
  if (vertices.length < 3 || vertices.length > 256) return;
  const diameter = 2 * vertices.reduce(
    (radius, point) => Math.max(radius, Math.hypot(point.x, point.y)),
    0,
  );
  if (Math.abs(input.diameterMm - diameter) > CUSTOM_DIAMETER_TOLERANCE_MM + 1e-9) {
    context.addIssue({ code: "custom", path: ["diameterMm"], message: "Diameter must match twice the maximum outline radius" });
  }
});

export const layerSchema = geometryInputSchema.safeExtend({
  id: z.string().min(1),
  position: z.enum(["top", "middle", "bottom"]),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
});

const layersSchema = z
  .tuple([
    layerSchema.safeExtend({ position: z.literal("top") }),
    layerSchema.safeExtend({ position: z.literal("middle") }),
    layerSchema.safeExtend({ position: z.literal("bottom") }),
  ])
  .superRefine((layers, context) => {
    if (new Set(layers.map((layer) => layer.id)).size !== layers.length) {
      context.addIssue({
        code: "custom",
        message: "Layer ids must be unique",
      });
    }
  });

export const designSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(40),
  layers: layersSchema,
  screwLayout: z.object({
    count: z.number().int().min(3).max(8),
    radiusMm: z.number().min(5).max(25),
    rotationDeg: z.number().min(0).max(359),
  }),
  metalDiscDiameterMm: z.union([
    z.literal(0),
    z.number().min(10).max(55),
  ]),
});

export type Layer = z.infer<typeof layerSchema>;
export type TopDesign = z.infer<typeof designSchema>;

export function makeDefaultDesign(): TopDesign {
  return {
    id: crypto.randomUUID(),
    name: "我的陀螺",
    layers: [
      {
        id: crypto.randomUUID(),
        position: "top",
        shape: "circle",
        points: 6,
        diameterMm: 40,
        cornerRoundness: 0.5,
        rotationDeg: 0,
        color: "#2563eb",
      },
      {
        id: crypto.randomUUID(),
        position: "middle",
        shape: "polygon",
        points: 6,
        diameterMm: 55,
        cornerRoundness: 0.5,
        rotationDeg: 0,
        color: "#60a5fa",
      },
      {
        id: crypto.randomUUID(),
        position: "bottom",
        shape: "circle",
        points: 6,
        diameterMm: 48,
        cornerRoundness: 0.5,
        rotationDeg: 0,
        color: "#bfdbfe",
      },
    ],
    screwLayout: {
      count: 4,
      radiusMm: 15,
      rotationDeg: 0,
    },
    metalDiscDiameterMm: 0,
  };
}
