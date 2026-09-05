import { and, asc, eq, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseClient } from "@steam-top/db";
import { buildDesignSnapshotRows } from "@steam-top/db/persistence";
import { designEventSnapshots, designLayers, designs, identities } from "@steam-top/db/schema";
import {
  designSchema,
  predictDesignPerformance,
  validateDesign,
  type PerformancePrediction,
  type TopDesign,
} from "@steam-top/domain";

export const DESIGN_SCHEMA_VERSION = "1.0.0" as const;

export type PersistedDesign = Readonly<{
  designId: string;
  ownerIdentityId: string;
  version: number;
  design: TopDesign;
  massG: number;
  performance: PerformancePrediction;
}>;

export interface DesignRepository {
  mostPopularBattleDesign?(): Promise<TopDesign | undefined>;
  saveBattleEligible(ownerIdentityId: string, input: unknown): Promise<PersistedDesign>;
  getOwned(ownerIdentityId: string, designId: string): Promise<PersistedDesign | undefined>;
}

export class DesignPersistenceError extends Error {
  constructor(readonly code: "DESIGN_INVALID" | "DESIGN_NOT_OWNED") {
    super(code);
    this.name = "DesignPersistenceError";
  }
}

const stable = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(",")}}`;
};

const canonical = (input: unknown): TopDesign => {
  const parsed = designSchema.parse(input);
  const validation = validateDesign(parsed);
  if (!validation.valid) throw new DesignPersistenceError("DESIGN_INVALID");
  return parsed;
};

const fingerprint = (identityId: string, design: TopDesign): string =>
  createHash("sha256").update(identityId).update("\0").update(stable(design)).digest("hex");

const materialize = (ownerIdentityId: string, designId: string, version: number, design: TopDesign): PersistedDesign => {
  const validation = validateDesign(design);
  if (!validation.valid) throw new DesignPersistenceError("DESIGN_INVALID");
  return Object.freeze({
    designId,
    ownerIdentityId,
    version,
    design: structuredClone(design),
    massG: validation.massProperties.totalMassG,
    performance: predictDesignPerformance(design),
  });
};

export class MemoryDesignRepository implements DesignRepository {
  readonly #records = new Map<string, PersistedDesign>();
  readonly #fingerprints = new Map<string, string>();
  readonly #maxEntries: number;
  constructor(options: Readonly<{ maxEntries?: number }> = {}) {
    this.#maxEntries = options.maxEntries ?? 2_000;
  }
  async saveBattleEligible(ownerIdentityId: string, input: unknown): Promise<PersistedDesign> {
    const design = canonical(input);
    const key = fingerprint(ownerIdentityId, design);
    const existingId = this.#fingerprints.get(key);
    if (existingId) return structuredClone(this.#records.get(existingId)!);
    const record = materialize(ownerIdentityId, randomUUID(), 1, design);
    this.#records.set(record.designId, record);
    this.#fingerprints.set(key, record.designId);
    while (this.#records.size > this.#maxEntries) {
      const oldest = this.#records.entries().next().value as [string, PersistedDesign] | undefined;
      if (!oldest) break;
      this.#records.delete(oldest[0]);
      this.#fingerprints.delete(fingerprint(oldest[1].ownerIdentityId, oldest[1].design));
    }
    return structuredClone(record);
  }
  async getOwned(ownerIdentityId: string, designId: string): Promise<PersistedDesign | undefined> {
    const record = this.#records.get(designId);
    return record?.ownerIdentityId === ownerIdentityId ? structuredClone(record) : undefined;
  }
}

type Db = DatabaseClient["db"];

export class PostgresDesignRepository implements DesignRepository {
  constructor(readonly db: Db) {}

  async mostPopularBattleDesign(): Promise<TopDesign | undefined> {
    const rows = await this.db.execute<{ id: string; owner: string }>(sql`
      with usage as (
        select player1_design_id id from matches where status = 'completed' and player1_identity_id is not null
        union all
        select player2_design_id id from matches where status = 'completed' and player2_identity_id is not null
      ), shapes as (
        select d.id, d.owner_identity_id owner,
          jsonb_build_array(d.screw_count, d.screw_radius_mm, d.screw_rotation_deg, d.metal_disc_diameter_mm,
            (select jsonb_agg(jsonb_build_array(l.position,l.shape,l.points,l.diameter_mm,l.corner_roundness,l.rotation_deg) order by l.layer_order)
             from design_layers l where l.design_id=d.id)) signature,
          count(*) uses
        from usage u join designs d on d.id=u.id where d.battle_eligible=true
        group by d.id
      ), ranked as (
        select id, owner, sum(uses) over(partition by signature) popularity from shapes
      ) select id,owner from ranked order by popularity desc,id limit 1`);
    const row = rows[0];
    return row ? (await this.#load(this.db, row.owner, row.id))?.design : undefined;
  }

  async saveBattleEligible(ownerIdentityId: string, input: unknown): Promise<PersistedDesign> {
    const design = canonical(input);
    return this.db.transaction(async (tx) => {
      // Serialises versions and exact-design reuse for one logical design owner.
      await tx.execute(
        // hashtext is only a lock namespace; identity UUID remains the authority.
        // eslint-disable-next-line drizzle/enforce-delete-with-where
        (await import("drizzle-orm")).sql`select pg_advisory_xact_lock(hashtext(${ownerIdentityId}))`,
      );
      const owned = await tx.select().from(designs)
        .where(and(eq(designs.ownerIdentityId, ownerIdentityId), eq(designs.logicalDesignId, design.id)))
        .orderBy(asc(designs.version));
      for (const row of owned) {
        const loaded = await this.#load(tx, ownerIdentityId, row.id);
        if (loaded && stable(loaded.design) === stable(design)) return loaded;
      }
      const version = (owned.at(-1)?.version ?? 0) + 1;
      const snapshotId = randomUUID();
      const built = buildDesignSnapshotRows({
        snapshotId,
        ownerIdentityId,
        version,
        schemaVersion: DESIGN_SCHEMA_VERSION,
        design: { ...design, id: design.id },
      });
      if (!built.activateBattleEligible) throw new DesignPersistenceError("DESIGN_INVALID");
      await tx.insert(designs).values(built.design);
      await tx.insert(designLayers).values([...built.layers]);
      const [owner] = await tx.select().from(identities).where(eq(identities.id, ownerIdentityId)).limit(1);
      const canonicalRows = await tx.execute<{ id: string }>((await import("drizzle-orm")).sql`with recursive chain as (
        select id,merged_into_identity_id,0 depth from identities where id=${ownerIdentityId}
        union all select i.id,i.merged_into_identity_id,c.depth+1 from identities i join chain c on i.id=c.merged_into_identity_id where c.depth<16
      ) select id from chain order by depth desc limit 1`);
      await tx.insert(designEventSnapshots).values({ designId: snapshotId, ownerIdentityIdAtCreation: ownerIdentityId, canonicalIdentityIdAtCreation: canonicalRows[0]?.id ?? ownerIdentityId, identityStatusSnapshot: owner?.status ?? null, classNameSnapshot: owner?.className ?? null, capturedAt: built.design.createdAt ?? new Date() });
      const activated = await tx.update(designs).set({ battleEligible: true })
        .where(and(eq(designs.id, snapshotId), eq(designs.battleEligible, false))).returning({ id: designs.id });
      if (activated.length !== 1) throw new Error("DESIGN_ACTIVATION_FAILED");
      return materialize(ownerIdentityId, snapshotId, version, design);
    });
  }

  async getOwned(ownerIdentityId: string, designId: string): Promise<PersistedDesign | undefined> {
    return this.#load(this.db, ownerIdentityId, designId);
  }

  async #load(db: Pick<Db, "select">, ownerIdentityId: string, designId: string): Promise<PersistedDesign | undefined> {
    const [row] = await db.select().from(designs).where(and(
      eq(designs.id, designId),
      eq(designs.ownerIdentityId, ownerIdentityId),
      eq(designs.battleEligible, true),
    )).limit(1);
    if (!row) return undefined;
    const layers = await db.select().from(designLayers).where(eq(designLayers.designId, row.id)).orderBy(asc(designLayers.layerOrder));
    if (layers.length !== 3) return undefined;
    const design = designSchema.parse({
      id: row.logicalDesignId,
      name: row.name,
      layers: layers.map((layer) => ({
        id: layer.sourceLayerId,
        position: layer.position,
        shape: layer.shape,
        points: layer.points,
        diameterMm: layer.diameterMm,
        cornerRoundness: layer.cornerRoundness,
        rotationDeg: layer.rotationDeg,
        color: layer.color,
      })),
      screwLayout: { count: row.screwCount, radiusMm: row.screwRadiusMm, rotationDeg: row.screwRotationDeg },
      metalDiscDiameterMm: row.metalDiscDiameterMm,
    });
    return materialize(ownerIdentityId, row.id, row.version, design);
  }
}
