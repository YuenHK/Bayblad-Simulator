import { z } from "zod";
import { PERFORMANCE_MODEL_VERSION } from "./performance";

export const performancePredictionSchema = z.object({
  speed: z.number().finite().min(0).max(100),
  spinDuration: z.number().finite().min(0).max(100),
  stability: z.number().finite().min(0).max(100),
  impactResistance: z.number().finite().min(0).max(100),
  modelVersion: z.literal(PERFORMANCE_MODEL_VERSION),
}).strict();

export const designUploadResponseSchema = z.object({
  designId: z.uuid(),
  massG: z.number().finite().positive(),
  performance: performancePredictionSchema,
}).strict();

export type DesignUploadResponse = z.infer<typeof designUploadResponseSchema>;
