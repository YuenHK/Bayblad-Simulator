import {
  designSchema,
  layerSchema,
  predictDesignPerformance,
  validateDesign,
  type PerformancePrediction,
  type TopDesign,
} from "@steam-top/domain";
import { z } from "zod";

const strictLayerSchema = layerSchema.strict();
const strictDesignSchema = designSchema.extend({
  layers: z.tuple([
    strictLayerSchema.extend({ position: z.literal("top") }),
    strictLayerSchema.extend({ position: z.literal("middle") }),
    strictLayerSchema.extend({ position: z.literal("bottom") }),
  ]).superRefine((layers, context) => {
    if (new Set(layers.map(({ id }) => id)).size !== layers.length) {
      context.addIssue({ code: "custom", message: "Layer ids must be unique" });
    }
  }),
  screwLayout: z.object({
    count: z.number().int().min(3).max(8),
    radiusMm: z.number().min(5).max(25),
    rotationDeg: z.number().min(0).max(359),
  }).strict(),
}).strict();

export type StoredDesign = Readonly<{
  designId: string;
  ownerSessionId: string;
  design: TopDesign;
  massG: number;
  performance: PerformancePrediction;
}>;

export type DesignRegistryErrorCode =
  | "DESIGN_INVALID"
  | "DESIGN_NOT_FOUND"
  | "DESIGN_NOT_OWNED";

export class DesignRegistryError extends Error {
  constructor(readonly code: DesignRegistryErrorCode) {
    super(code);
    this.name = "DesignRegistryError";
  }
}

function clone(value: StoredDesign): StoredDesign {
  return structuredClone(value);
}

export class DesignRegistry {
  readonly #createDesignId: () => string;
  readonly #designs = new Map<string, StoredDesign>();

  constructor(options: Readonly<{ createDesignId?: () => string }> = {}) {
    this.#createDesignId = options.createDesignId ?? (() => crypto.randomUUID());
  }

  register(ownerSessionId: string, input: unknown): StoredDesign {
    const parsed = strictDesignSchema.safeParse(input);
    if (!parsed.success) throw new DesignRegistryError("DESIGN_INVALID");
    const validation = validateDesign(parsed.data);
    if (!validation.valid) throw new DesignRegistryError("DESIGN_INVALID");
    const designId = this.#createDesignId();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(designId)) {
      throw new DesignRegistryError("DESIGN_INVALID");
    }
    const stored: StoredDesign = {
      designId,
      ownerSessionId,
      design: structuredClone(parsed.data),
      massG: validation.massProperties.totalMassG,
      performance: predictDesignPerformance(parsed.data),
    };
    this.#designs.set(designId, structuredClone(stored));
    return clone(stored);
  }

  requireOwned(ownerSessionId: string, designId: string): StoredDesign {
    const stored = this.#designs.get(designId);
    if (!stored) throw new DesignRegistryError("DESIGN_NOT_FOUND");
    if (stored.ownerSessionId !== ownerSessionId) {
      throw new DesignRegistryError("DESIGN_NOT_OWNED");
    }
    return clone(stored);
  }
}
