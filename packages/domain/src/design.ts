import { z } from "zod";

export const layerSchema = z.object({
  id: z.string().min(1),
  position: z.enum(["top", "middle", "bottom"]),
  shape: z.enum(["circle", "polygon", "star", "wave"]),
  points: z.number().int().min(3).max(16),
  diameterMm: z.number().min(20).max(80),
  cornerRoundness: z.number().min(0).max(1),
  rotationDeg: z.number().min(0).max(359),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
});

const layersSchema = z
  .tuple([
    layerSchema.extend({ position: z.literal("top") }),
    layerSchema.extend({ position: z.literal("middle") }),
    layerSchema.extend({ position: z.literal("bottom") }),
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
      radiusMm: 18,
      rotationDeg: 0,
    },
    metalDiscDiameterMm: 0,
  };
}
