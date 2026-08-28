import {
  designSchema,
  layerSchema,
  predictDesignPerformance,
  validateDesign,
  type PerformancePrediction,
  type TopDesign,
} from "@steam-top/domain";
import { z } from "zod";
import type { PublicBattleDesign } from "@steam-top/protocol";

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
  | "DESIGN_NOT_OWNED"
  | "DESIGN_QUOTA_EXCEEDED"
  | "DESIGN_ID_GENERATION_FAILED";

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
  readonly #now: () => number;
  readonly #maxGlobal: number;
  readonly #maxPerOwner: number;
  readonly #ttlMs: number;
  readonly #designs = new Map<string, { value: StoredDesign; lastUsedAt: number; pins: number }>();

  constructor(options: Readonly<{
    createDesignId?: () => string;
    now?: () => number;
    maxGlobal?: number;
    maxPerOwner?: number;
    ttlMs?: number;
  }> = {}) {
    this.#createDesignId = options.createDesignId ?? (() => crypto.randomUUID());
    this.#now = options.now ?? Date.now;
    this.#maxGlobal = options.maxGlobal ?? 2_000;
    this.#maxPerOwner = options.maxPerOwner ?? 20;
    this.#ttlMs = options.ttlMs ?? 24 * 60 * 60_000;
  }

  register(ownerSessionId: string, input: unknown): StoredDesign {
    const parsed = strictDesignSchema.safeParse(input);
    if (!parsed.success) throw new DesignRegistryError("DESIGN_INVALID");
    const validation = validateDesign(parsed.data);
    if (!validation.valid) throw new DesignRegistryError("DESIGN_INVALID");
    this.#prune();
    const owned = [...this.#designs.values()].filter(({ value }) => value.ownerSessionId === ownerSessionId).length;
    if (owned >= this.#maxPerOwner) throw new DesignRegistryError("DESIGN_QUOTA_EXCEEDED");
    this.#makeCapacity();
    const designId = this.#uniqueId();
    const stored: StoredDesign = {
      designId,
      ownerSessionId,
      design: structuredClone(parsed.data),
      massG: validation.massProperties.totalMassG,
      performance: predictDesignPerformance(parsed.data),
    };
    this.#designs.set(designId, { value: structuredClone(stored), lastUsedAt: this.#readNow(), pins: 0 });
    return clone(stored);
  }

  requireOwned(ownerSessionId: string, designId: string): StoredDesign {
    this.#prune();
    const record = this.#designs.get(designId);
    if (!record) throw new DesignRegistryError("DESIGN_NOT_FOUND");
    if (record.value.ownerSessionId !== ownerSessionId) {
      throw new DesignRegistryError("DESIGN_NOT_OWNED");
    }
    record.lastUsedAt = this.#readNow();
    return clone(record.value);
  }

  publicBattleDesign(ownerSessionId: string, designId: string): PublicBattleDesign {
    const { design } = this.requireOwned(ownerSessionId, designId);
    return structuredClone({
      layers: design.layers,
      screwLayout: design.screwLayout,
      metalDiscDiameterMm: design.metalDiscDiameterMm,
    });
  }

  pin(ownerSessionId: string, designId: string): void {
    this.requireOwned(ownerSessionId, designId);
    this.#designs.get(designId)!.pins += 1;
  }

  unpin(ownerSessionId: string, designId: string): void {
    const record = this.#designs.get(designId);
    if (!record || record.value.ownerSessionId !== ownerSessionId) return;
    record.pins = Math.max(0, record.pins - 1);
  }

  cleanupOwner(ownerSessionId: string): number {
    let removed = 0;
    for (const [id, record] of this.#designs) {
      if (record.value.ownerSessionId === ownerSessionId && record.pins === 0) {
        this.#designs.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  debugCounts(): Readonly<{ total: number; owners: number; pinned: number }> {
    this.#prune();
    return {
      total: this.#designs.size,
      owners: new Set([...this.#designs.values()].map(({ value }) => value.ownerSessionId)).size,
      pinned: [...this.#designs.values()].filter(({ pins }) => pins > 0).length,
    };
  }

  #readNow(): number {
    const now = this.#now();
    if (!Number.isFinite(now)) throw new DesignRegistryError("DESIGN_INVALID");
    return now;
  }

  #prune(): void {
    const now = this.#readNow();
    for (const [id, record] of this.#designs) {
      if (record.pins === 0 && now - record.lastUsedAt >= this.#ttlMs) this.#designs.delete(id);
    }
  }

  #makeCapacity(): void {
    while (this.#designs.size >= this.#maxGlobal) {
      const candidate = [...this.#designs.entries()]
        .filter(([, { pins }]) => pins === 0)
        .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)[0];
      if (!candidate) throw new DesignRegistryError("DESIGN_QUOTA_EXCEEDED");
      this.#designs.delete(candidate[0]);
    }
  }

  #uniqueId(): string {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const id = this.#createDesignId();
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id) && !this.#designs.has(id)) return id;
    }
    throw new DesignRegistryError("DESIGN_ID_GENERATION_FAILED");
  }
}
