import { relations, sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  inet,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

export const identityStatusEnum = pgEnum("identity_status", [
  "iclass",
  "cookie",
  "guest",
]);
export const identityLinkReasonEnum = pgEnum("identity_link_reason", [
  "verified_cookie_and_iclass",
  "admin_correction",
]);
export const topLayerPositionEnum = pgEnum("top_layer_position", [
  "top",
  "middle",
  "bottom",
]);
export const topShapeEnum = pgEnum("top_shape", [
  "circle",
  "polygon",
  "star",
  "wave",
]);
export const metalDiscPlacementEnum = pgEnum("metal_disc_placement", [
  "under_bottom",
]);
export const roomStatusEnum = pgEnum("room_status", [
  "waiting",
  "launch",
  "battle",
  "result",
  "closed",
]);
export const participantRoleEnum = pgEnum("participant_role", [
  "player1",
  "player2",
  "spectator",
]);
export const matchStatusEnum = pgEnum("match_status", [
  "in_progress",
  "completed",
  "persist_failed",
  "cancelled",
]);
export const playerSlotEnum = pgEnum("player_slot", ["player1", "player2"]);
export const battleOutcomeEnum = pgEnum("battle_outcome", [
  "player1",
  "player2",
  "draw",
]);
export const battleReasonEnum = pgEnum("battle_reason", [
  "stopped",
  "out-of-bounds",
  "timeout",
  "simultaneous",
]);
export const launchGradeEnum = pgEnum("launch_grade", [
  "Perfect",
  "Great",
  "Good",
  "Miss",
]);
export const auditOutcomeEnum = pgEnum("audit_outcome", [
  "success",
  "failure",
  "denied",
]);
export const deletionScopeEnum = pgEnum("deletion_scope", [
  "identity",
  "class",
  "date_range",
  "all",
]);

export type CanonicalDesignJson = Readonly<{
  id: string;
  name: string;
  layers: readonly Readonly<Record<string, unknown>>[];
  screwLayout: Readonly<Record<string, unknown>>;
  metalDiscDiameterMm: number;
}>;

export type PerformanceSnapshot = Readonly<{
  speed: number;
  spinDuration: number;
  stability: number;
  impactResistance: number;
  modelVersion: string;
}>;

export type BattleResultSnapshot = Readonly<Record<string, unknown>>;

export const identities = pgTable(
  "identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    status: identityStatusEnum("status").notNull(),
    displayName: text("display_name").notNull(),
    studentName: text("student_name"),
    className: text("class_name"),
    studentNumber: text("student_number"),
    deviceName: text("device_name"),
    anonymousDeviceId: uuid("anonymous_device_id").notNull().defaultRandom(),
    iclassExternalId: text("iclass_external_id"),
    externalDeviceId: text("external_device_id"),
    mergedIntoIdentityId: uuid("merged_into_identity_id").references(
      (): AnyPgColumn => identities.id,
      { onDelete: "set null" },
    ),
    mergedAt: timestamp("merged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("identities_anonymous_device_id_uidx").on(
      table.anonymousDeviceId,
    ),
    uniqueIndex("identities_iclass_external_id_uidx")
      .on(table.iclassExternalId)
      .where(sql`${table.iclassExternalId} is not null`),
    index("identities_class_student_idx").on(
      table.className,
      table.studentNumber,
    ),
    index("identities_status_last_seen_idx").on(table.status, table.lastSeenAt),
    index("identities_merged_into_idx").on(table.mergedIntoIdentityId),
    check(
      "identities_merge_fields_consistent",
      sql`(${table.mergedIntoIdentityId} is null and ${table.mergedAt} is null) or (${table.mergedIntoIdentityId} is not null and ${table.mergedAt} is not null and ${table.mergedIntoIdentityId} <> ${table.id})`,
    ),
  ],
);

export const identityLinks = pgTable(
  "identity_links",
  {
    sourceIdentityId: uuid("source_identity_id")
      .notNull()
      .references(() => identities.id, { onDelete: "cascade" }),
    targetIdentityId: uuid("target_identity_id")
      .notNull()
      .references(() => identities.id, { onDelete: "cascade" }),
    reason: identityLinkReasonEnum("reason").notNull(),
    verificationFingerprint: text("verification_fingerprint").notNull(),
    linkedAt: timestamp("linked_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.sourceIdentityId, table.targetIdentityId] }),
    uniqueIndex("identity_links_source_uidx").on(table.sourceIdentityId),
    index("identity_links_target_idx").on(table.targetIdentityId),
    check(
      "identity_links_distinct_identities",
      sql`${table.sourceIdentityId} <> ${table.targetIdentityId}`,
    ),
    check(
      "identity_links_fingerprint_format",
      sql`${table.verificationFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

export const identitySessions = pgTable(
  "identity_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identityId: uuid("identity_id")
      .notNull()
      .references(() => identities.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastIp: inet("last_ip"),
    userAgent: text("user_agent"),
  },
  (table) => [
    uniqueIndex("identity_sessions_token_hash_uidx").on(table.tokenHash),
    index("identity_sessions_identity_last_seen_idx").on(
      table.identityId,
      table.lastSeenAt,
    ),
    index("identity_sessions_expires_at_idx").on(table.expiresAt),
    check(
      "identity_sessions_token_hash_format",
      sql`${table.tokenHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "identity_sessions_expiry_after_creation",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
  ],
);

export const designs = pgTable(
  "designs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    logicalDesignId: uuid("logical_design_id").notNull(),
    ownerIdentityId: uuid("owner_identity_id").references(() => identities.id, {
      onDelete: "set null",
    }),
    version: integer("version").notNull(),
    schemaVersion: text("schema_version").notNull(),
    name: text("name").notNull(),
    screwCount: smallint("screw_count").notNull(),
    screwRadiusMm: numeric("screw_radius_mm", {
      precision: 7,
      scale: 3,
      mode: "number",
    }).notNull(),
    screwRotationDeg: numeric("screw_rotation_deg", {
      precision: 7,
      scale: 3,
      mode: "number",
    }).notNull(),
    metalDiscDiameterMm: numeric("metal_disc_diameter_mm", {
      precision: 7,
      scale: 3,
      mode: "number",
    }).notNull(),
    metalDiscPlacement: metalDiscPlacementEnum("metal_disc_placement")
      .notNull()
      .default("under_bottom"),
    totalMassG: numeric("total_mass_g", {
      precision: 10,
      scale: 4,
      mode: "number",
    }).notNull(),
    polarMomentGmm2: numeric("polar_moment_gmm2", {
      precision: 16,
      scale: 4,
      mode: "number",
    }).notNull(),
    centerOfMassXMm: numeric("center_of_mass_x_mm", {
      precision: 10,
      scale: 5,
      mode: "number",
    }).notNull(),
    centerOfMassYMm: numeric("center_of_mass_y_mm", {
      precision: 10,
      scale: 5,
      mode: "number",
    }).notNull(),
    performanceSpeed: numeric("performance_speed", {
      precision: 7,
      scale: 3,
      mode: "number",
    }).notNull(),
    performanceSpinDuration: numeric("performance_spin_duration", {
      precision: 7,
      scale: 3,
      mode: "number",
    }).notNull(),
    performanceStability: numeric("performance_stability", {
      precision: 7,
      scale: 3,
      mode: "number",
    }).notNull(),
    performanceImpactResistance: numeric("performance_impact_resistance", {
      precision: 7,
      scale: 3,
      mode: "number",
    }).notNull(),
    performanceModelVersion: text("performance_model_version").notNull(),
    canonicalJson: jsonb("canonical_json").$type<CanonicalDesignJson>().notNull(),
    performanceJson: jsonb("performance_json")
      .$type<PerformanceSnapshot>()
      .notNull(),
    // Repositories must write a design and its layers in one transaction.
    // A deferred PostgreSQL constraint trigger validates exact layer topology
    // before any battle-eligible snapshot can commit.
    battleEligible: boolean("battle_eligible").notNull().default(false),
    validationIssues: jsonb("validation_issues")
      .$type<readonly string[]>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("designs_logical_version_uidx").on(
      table.logicalDesignId,
      table.version,
    ),
    index("designs_owner_created_at_idx").on(
      table.ownerIdentityId,
      table.createdAt,
    ),
    index("designs_performance_model_idx").on(
      table.performanceModelVersion,
      table.createdAt,
    ),
    check("designs_version_positive", sql`${table.version} > 0`),
    check(
      "designs_screw_count_range",
      sql`${table.screwCount} between 3 and 8`,
    ),
    check(
      "designs_screw_radius_range",
      sql`${table.screwRadiusMm} between 5 and 25`,
    ),
    check(
      "designs_screw_rotation_range",
      sql`${table.screwRotationDeg} >= 0 and ${table.screwRotationDeg} < 360`,
    ),
    check(
      "designs_metal_disc_range",
      sql`${table.metalDiscDiameterMm} = 0 or ${table.metalDiscDiameterMm} between 10 and 55`,
    ),
    check(
      "designs_metal_disc_placement",
      sql`${table.metalDiscPlacement} = 'under_bottom'`,
    ),
    check(
      "designs_physics_values_positive",
      sql`${table.totalMassG} > 0 and ${table.totalMassG} <= 60 and ${table.polarMomentGmm2} > 0`,
    ),
    check(
      "designs_performance_range",
      sql`${table.performanceSpeed} between 0 and 100 and ${table.performanceSpinDuration} between 0 and 100 and ${table.performanceStability} between 0 and 100 and ${table.performanceImpactResistance} between 0 and 100`,
    ),
    check(
      "designs_battle_eligibility_consistent",
      sql`jsonb_typeof(${table.validationIssues}) = 'array' and (not ${table.battleEligible} or jsonb_array_length(${table.validationIssues}) = 0)`,
    ),
    check(
      "designs_model_versions_nonblank",
      sql`length(btrim(${table.schemaVersion})) > 0 and length(btrim(${table.performanceModelVersion})) > 0`,
    ),
  ],
);

export const designLayers = pgTable(
  "design_layers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    designId: uuid("design_id")
      .notNull()
      .references(() => designs.id, { onDelete: "cascade" }),
    sourceLayerId: text("source_layer_id").notNull(),
    layerOrder: smallint("layer_order").notNull(),
    position: topLayerPositionEnum("position").notNull(),
    shape: topShapeEnum("shape").notNull(),
    points: smallint("points").notNull(),
    diameterMm: numeric("diameter_mm", {
      precision: 7,
      scale: 3,
      mode: "number",
    }).notNull(),
    cornerRoundness: numeric("corner_roundness", {
      precision: 5,
      scale: 4,
      mode: "number",
    }).notNull(),
    rotationDeg: numeric("rotation_deg", {
      precision: 7,
      scale: 3,
      mode: "number",
    }).notNull(),
    color: text("color").notNull(),
  },
  (table) => [
    uniqueIndex("design_layers_design_order_uidx").on(
      table.designId,
      table.layerOrder,
    ),
    uniqueIndex("design_layers_design_position_uidx").on(
      table.designId,
      table.position,
    ),
    uniqueIndex("design_layers_design_source_id_uidx").on(
      table.designId,
      table.sourceLayerId,
    ),
    index("design_layers_parameter_analytics_idx").on(
      table.shape,
      table.points,
      table.diameterMm,
      table.cornerRoundness,
    ),
    check(
      "design_layers_order_range",
      sql`${table.layerOrder} between 0 and 2`,
    ),
    check(
      "design_layers_position_matches_order",
      sql`(${table.layerOrder} = 0 and ${table.position} = 'top') or (${table.layerOrder} = 1 and ${table.position} = 'middle') or (${table.layerOrder} = 2 and ${table.position} = 'bottom')`,
    ),
    check(
      "design_layers_points_range",
      sql`${table.points} between 3 and 16`,
    ),
    check(
      "design_layers_diameter_range",
      sql`${table.diameterMm} between 20 and 80`,
    ),
    check(
      "design_layers_roundness_range",
      sql`${table.cornerRoundness} between 0 and 1`,
    ),
    check(
      "design_layers_rotation_range",
      sql`${table.rotationDeg} >= 0 and ${table.rotationDeg} < 360`,
    ),
    check(
      "design_layers_color_format",
      sql`${table.color} ~ '^#[0-9A-Fa-f]{6}$'`,
    ),
  ],
);

export const rooms = pgTable(
  "rooms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    ownerIdentityId: uuid("owner_identity_id").references(() => identities.id, {
      onDelete: "set null",
    }),
    status: roomStatusEnum("status").notNull().default("waiting"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    firstBattleAt: timestamp("first_battle_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("rooms_code_active_uidx")
      .on(table.code)
      .where(sql`${table.closedAt} is null`),
    index("rooms_created_at_idx").on(table.createdAt),
    index("rooms_status_created_at_idx").on(table.status, table.createdAt),
    index("rooms_owner_created_at_idx").on(
      table.ownerIdentityId,
      table.createdAt,
    ),
    check(
      "rooms_closed_status_consistent",
      sql`${table.closedAt} is null or ${table.status} = 'closed'`,
    ),
  ],
);

export const roomParticipants = pgTable(
  "room_participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    identityId: uuid("identity_id").references(() => identities.id, {
      onDelete: "set null",
    }),
    participantPublicId: text("participant_public_id").notNull(),
    displayNameSnapshot: text("display_name_snapshot").notNull(),
    role: participantRoleEnum("role").notNull(),
    isOwner: boolean("is_owner").notNull().default(false),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leftAt: timestamp("left_at", { withTimezone: true }),
    lastIp: inet("last_ip"),
    userAgent: text("user_agent"),
    deviceNameSnapshot: text("device_name_snapshot"),
  },
  (table) => [
    uniqueIndex("room_participants_room_public_id_uidx").on(
      table.roomId,
      table.participantPublicId,
    ),
    uniqueIndex("room_participants_active_player_seat_uidx")
      .on(table.roomId, table.role)
      .where(
        sql`${table.leftAt} is null and ${table.role} in ('player1', 'player2')`,
      ),
    index("room_participants_identity_joined_idx").on(
      table.identityId,
      table.joinedAt,
    ),
    index("room_participants_room_joined_idx").on(table.roomId, table.joinedAt),
    check(
      "room_participants_time_order",
      sql`${table.leftAt} is null or ${table.leftAt} >= ${table.joinedAt}`,
    ),
  ],
);

export const matches = pgTable(
  "matches",
  {
    id: uuid("id").primaryKey(),
    roomId: uuid("room_id").references(() => rooms.id, { onDelete: "set null" }),
    idempotencyFingerprint: text("idempotency_fingerprint").notNull(),
    status: matchStatusEnum("status").notNull().default("in_progress"),
    player1IdentityId: uuid("player1_identity_id").references(
      () => identities.id,
      { onDelete: "set null" },
    ),
    player2IdentityId: uuid("player2_identity_id").references(
      () => identities.id,
      { onDelete: "set null" },
    ),
    player1DesignId: uuid("player1_design_id")
      .notNull()
      .references(() => designs.id, { onDelete: "restrict" }),
    player2DesignId: uuid("player2_design_id")
      .notNull()
      .references(() => designs.id, { onDelete: "restrict" }),
    player1BattlePoints: smallint("player1_battle_points"),
    player2BattlePoints: smallint("player2_battle_points"),
    player1ChallengePoints: numeric("player1_challenge_points", {
      precision: 4,
      scale: 3,
      mode: "number",
    }),
    player2ChallengePoints: numeric("player2_challenge_points", {
      precision: 4,
      scale: 3,
      mode: "number",
    }),
    player1Total: numeric("player1_total", {
      precision: 5,
      scale: 3,
      mode: "number",
    }),
    player2Total: numeric("player2_total", {
      precision: 5,
      scale: 3,
      mode: "number",
    }),
    winner: playerSlotEnum("winner"),
    roundWinners: jsonb("round_winners").$type<readonly ("player1" | "player2")[]>(),
    performanceModelVersion: text("performance_model_version").notNull(),
    physicsModelVersion: text("physics_model_version").notNull(),
    protocolVersion: smallint("protocol_version").notNull(),
    spectatorCount: integer("spectator_count").notNull().default(0),
    player1Ip: inet("player1_ip"),
    player2Ip: inet("player2_ip"),
    player1UserAgent: text("player1_user_agent"),
    player2UserAgent: text("player2_user_agent"),
    player1DeviceName: text("player1_device_name"),
    player2DeviceName: text("player2_device_name"),
    persistFailureCode: text("persist_failure_code"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("matches_idempotency_fingerprint_uidx").on(
      table.idempotencyFingerprint,
    ),
    index("matches_completed_at_idx").on(table.completedAt),
    index("matches_status_completed_at_idx").on(table.status, table.completedAt),
    index("matches_player1_identity_idx").on(
      table.player1IdentityId,
      table.completedAt,
    ),
    index("matches_player2_identity_idx").on(
      table.player2IdentityId,
      table.completedAt,
    ),
    index("matches_model_versions_idx").on(
      table.performanceModelVersion,
      table.physicsModelVersion,
      table.completedAt,
    ),
    index("matches_room_started_at_idx").on(table.roomId, table.startedAt),
    check(
      "matches_idempotency_fingerprint_format",
      sql`${table.idempotencyFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "matches_spectator_count_nonnegative",
      sql`${table.spectatorCount} >= 0`,
    ),
    check(
      "matches_distinct_player_identities",
      sql`${table.player1IdentityId} is null or ${table.player2IdentityId} is null or ${table.player1IdentityId} <> ${table.player2IdentityId}`,
    ),
    check(
      "matches_challenge_points_range",
      sql`(${table.player1ChallengePoints} is null or ${table.player1ChallengePoints} between 0 and 0.5) and (${table.player2ChallengePoints} is null or ${table.player2ChallengePoints} between 0 and 0.5)`,
    ),
    check(
      "matches_completed_score_shape",
      sql`${table.status} <> 'completed' or (${table.completedAt} is not null and ${table.winner} is not null and ${table.player1BattlePoints} is not null and ${table.player2BattlePoints} is not null and ${table.player1ChallengePoints} is not null and ${table.player2ChallengePoints} is not null and ${table.player1Total} is not null and ${table.player2Total} is not null and ${table.roundWinners} is not null and jsonb_array_length(${table.roundWinners}) between 2 and 3 and ((${table.player1BattlePoints} = 2 and ${table.player2BattlePoints} in (0, 1) and ${table.winner} = 'player1') or (${table.player2BattlePoints} = 2 and ${table.player1BattlePoints} in (0, 1) and ${table.winner} = 'player2')))`,
    ),
    check(
      "matches_totals_consistent",
      sql`(${table.player1Total} is null and ${table.player1BattlePoints} is null and ${table.player1ChallengePoints} is null or ${table.player1Total} = ${table.player1BattlePoints} + ${table.player1ChallengePoints}) and (${table.player2Total} is null and ${table.player2BattlePoints} is null and ${table.player2ChallengePoints} is null or ${table.player2Total} = ${table.player2BattlePoints} + ${table.player2ChallengePoints})`,
    ),
    check(
      "matches_completed_time_order",
      sql`${table.completedAt} is null or ${table.completedAt} >= ${table.startedAt}`,
    ),
    check(
      "matches_model_versions_nonblank",
      sql`length(btrim(${table.performanceModelVersion})) > 0 and length(btrim(${table.physicsModelVersion})) > 0`,
    ),
    check(
      "matches_protocol_version_positive",
      sql`${table.protocolVersion} > 0`,
    ),
  ],
);

export const rounds = pgTable(
  "rounds",
  {
    id: uuid("id").primaryKey(),
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    externalRoundId: text("external_round_id").notNull(),
    authorityKeyHash: text("authority_key_hash").notNull(),
    roundNumber: smallint("round_number").notNull(),
    attempt: smallint("attempt").notNull(),
    seed: bigint("seed", { mode: "number" }).notNull(),
    outcome: battleOutcomeEnum("outcome").notNull(),
    outcomeReason: battleReasonEnum("outcome_reason").notNull(),
    ticks: integer("ticks").notNull(),
    launchGradeA: launchGradeEnum("launch_grade_a").notNull(),
    launchGradeB: launchGradeEnum("launch_grade_b").notNull(),
    launchAngularMultiplierA: numeric("launch_angular_multiplier_a", {
      precision: 6,
      scale: 4,
      mode: "number",
    }).notNull(),
    launchAngularMultiplierB: numeric("launch_angular_multiplier_b", {
      precision: 6,
      scale: 4,
      mode: "number",
    }).notNull(),
    launchLinearMultiplierA: numeric("launch_linear_multiplier_a", {
      precision: 6,
      scale: 4,
      mode: "number",
    }).notNull(),
    launchLinearMultiplierB: numeric("launch_linear_multiplier_b", {
      precision: 6,
      scale: 4,
      mode: "number",
    }).notNull(),
    physicsModelVersion: text("physics_model_version").notNull(),
    inputFingerprint: text("input_fingerprint").notNull(),
    battleResultJson: jsonb("battle_result_json")
      .$type<BattleResultSnapshot>()
      .notNull(),
    framesStrategy: text("frames_strategy").notNull().default("full_json_v1"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("rounds_match_round_attempt_uidx").on(
      table.matchId,
      table.roundNumber,
      table.attempt,
    ),
    uniqueIndex("rounds_authority_key_hash_uidx").on(table.authorityKeyHash),
    index("rounds_input_fingerprint_idx").on(table.inputFingerprint),
    index("rounds_completed_at_idx").on(table.completedAt),
    index("rounds_launch_grades_idx").on(
      table.launchGradeA,
      table.launchGradeB,
      table.completedAt,
    ),
    check("rounds_number_range", sql`${table.roundNumber} between 1 and 3`),
    check("rounds_attempt_positive", sql`${table.attempt} > 0`),
    check("rounds_ticks_nonnegative", sql`${table.ticks} >= 0 and ${table.ticks} <= 5400`),
    check(
      "rounds_seed_safe_integer",
      sql`${table.seed} between -9007199254740991 and 9007199254740991`,
    ),
    check(
      "rounds_launch_multiplier_range",
      sql`${table.launchAngularMultiplierA} between 0 and 2 and ${table.launchAngularMultiplierB} between 0 and 2 and ${table.launchLinearMultiplierA} between 0 and 2 and ${table.launchLinearMultiplierB} between 0 and 2`,
    ),
    check(
      "rounds_external_round_id_format",
      sql`length(${table.externalRoundId}) between 1 and 128 and ${table.externalRoundId} ~ '^[A-Za-z0-9_-]+$'`,
    ),
    check(
      "rounds_authority_key_hash_format",
      sql`${table.authorityKeyHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "rounds_input_fingerprint_format",
      sql`${table.inputFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "rounds_frames_strategy",
      sql`${table.framesStrategy} in ('full_json_v1', 'summary_v1')`,
    ),
    check(
      "rounds_time_order",
      sql`${table.completedAt} >= ${table.startedAt}`,
    ),
    check(
      "rounds_physics_model_version_nonblank",
      sql`length(btrim(${table.physicsModelVersion})) > 0`,
    ),
  ],
);

export const adminUsers = pgTable(
  "admin_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    username: text("username").notNull(),
    passwordHash: text("password_hash").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("admin_users_username_lower_uidx").on(sql`lower(${table.username})`),
    check(
      "admin_users_username_nonblank",
      sql`length(btrim(${table.username})) between 1 and 80`,
    ),
  ],
);

export const adminSessions = pgTable(
  "admin_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    adminUserId: uuid("admin_user_id")
      .notNull()
      .references(() => adminUsers.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    csrfTokenHash: text("csrf_token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastIp: inet("last_ip"),
    userAgent: text("user_agent"),
  },
  (table) => [
    uniqueIndex("admin_sessions_token_hash_uidx").on(table.tokenHash),
    index("admin_sessions_admin_last_seen_idx").on(
      table.adminUserId,
      table.lastSeenAt,
    ),
    index("admin_sessions_expires_at_idx").on(table.expiresAt),
    check(
      "admin_sessions_token_hash_format",
      sql`${table.tokenHash} ~ '^[a-f0-9]{64}$' and ${table.csrfTokenHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "admin_sessions_expiry_after_creation",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
  ],
);

export const adminAudit = pgTable(
  "admin_audit",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    adminUserId: uuid("admin_user_id").references(() => adminUsers.id, {
      onDelete: "set null",
    }),
    adminSessionId: uuid("admin_session_id").references(() => adminSessions.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    outcome: auditOutcomeEnum("outcome").notNull(),
    details: jsonb("details").$type<Readonly<Record<string, unknown>>>().notNull().default({}),
    requestIp: inet("request_ip"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("admin_audit_created_at_idx").on(table.createdAt),
    index("admin_audit_admin_action_idx").on(
      table.adminUserId,
      table.action,
      table.createdAt,
    ),
    index("admin_audit_target_idx").on(table.targetType, table.targetId),
  ],
);

export const deletionAudit = pgTable(
  "deletion_audit",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    adminUserId: uuid("admin_user_id").references(() => adminUsers.id, {
      onDelete: "set null",
    }),
    scope: deletionScopeEnum("scope").notNull(),
    filterHash: text("filter_hash").notNull(),
    previewCount: integer("preview_count").notNull(),
    deletedIdentityCount: integer("deleted_identity_count").notNull(),
    deletedDesignCount: integer("deleted_design_count").notNull(),
    deletedMatchCount: integer("deleted_match_count").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("deletion_audit_completed_at_idx").on(table.completedAt),
    index("deletion_audit_admin_completed_idx").on(
      table.adminUserId,
      table.completedAt,
    ),
    check(
      "deletion_audit_filter_hash_format",
      sql`${table.filterHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "deletion_audit_counts_nonnegative",
      sql`${table.previewCount} >= 0 and ${table.deletedIdentityCount} >= 0 and ${table.deletedDesignCount} >= 0 and ${table.deletedMatchCount} >= 0`,
    ),
  ],
);

export const identitiesRelations = relations(identities, ({ one, many }) => ({
  mergedInto: one(identities, {
    fields: [identities.mergedIntoIdentityId],
    references: [identities.id],
    relationName: "identityMerge",
  }),
  mergedSources: many(identities, { relationName: "identityMerge" }),
  sourceLinks: many(identityLinks, { relationName: "identityLinkSource" }),
  targetLinks: many(identityLinks, { relationName: "identityLinkTarget" }),
  sessions: many(identitySessions, { relationName: "identitySessions" }),
  designs: many(designs, { relationName: "ownedDesigns" }),
  ownedRooms: many(rooms, { relationName: "ownedRooms" }),
  roomParticipations: many(roomParticipants, {
    relationName: "identityRoomParticipants",
  }),
  player1Matches: many(matches, { relationName: "matchPlayer1Identity" }),
  player2Matches: many(matches, { relationName: "matchPlayer2Identity" }),
}));

export const identityLinksRelations = relations(identityLinks, ({ one }) => ({
  sourceIdentity: one(identities, {
    fields: [identityLinks.sourceIdentityId],
    references: [identities.id],
    relationName: "identityLinkSource",
  }),
  targetIdentity: one(identities, {
    fields: [identityLinks.targetIdentityId],
    references: [identities.id],
    relationName: "identityLinkTarget",
  }),
}));

export const identitySessionsRelations = relations(identitySessions, ({ one }) => ({
  identity: one(identities, {
    fields: [identitySessions.identityId],
    references: [identities.id],
    relationName: "identitySessions",
  }),
}));

export const designsRelations = relations(designs, ({ one, many }) => ({
  ownerIdentity: one(identities, {
    fields: [designs.ownerIdentityId],
    references: [identities.id],
    relationName: "ownedDesigns",
  }),
  layers: many(designLayers, { relationName: "designLayers" }),
  player1Matches: many(matches, { relationName: "matchPlayer1Design" }),
  player2Matches: many(matches, { relationName: "matchPlayer2Design" }),
}));

export const designLayersRelations = relations(designLayers, ({ one }) => ({
  design: one(designs, {
    fields: [designLayers.designId],
    references: [designs.id],
    relationName: "designLayers",
  }),
}));

export const roomsRelations = relations(rooms, ({ one, many }) => ({
  ownerIdentity: one(identities, {
    fields: [rooms.ownerIdentityId],
    references: [identities.id],
    relationName: "ownedRooms",
  }),
  participants: many(roomParticipants, { relationName: "roomParticipants" }),
  matches: many(matches, { relationName: "roomMatches" }),
}));

export const roomParticipantsRelations = relations(
  roomParticipants,
  ({ one }) => ({
    room: one(rooms, {
      fields: [roomParticipants.roomId],
      references: [rooms.id],
      relationName: "roomParticipants",
    }),
    identity: one(identities, {
      fields: [roomParticipants.identityId],
      references: [identities.id],
      relationName: "identityRoomParticipants",
    }),
  }),
);

export const matchesRelations = relations(matches, ({ one, many }) => ({
  room: one(rooms, {
    fields: [matches.roomId],
    references: [rooms.id],
    relationName: "roomMatches",
  }),
  player1Identity: one(identities, {
    fields: [matches.player1IdentityId],
    references: [identities.id],
    relationName: "matchPlayer1Identity",
  }),
  player2Identity: one(identities, {
    fields: [matches.player2IdentityId],
    references: [identities.id],
    relationName: "matchPlayer2Identity",
  }),
  player1Design: one(designs, {
    fields: [matches.player1DesignId],
    references: [designs.id],
    relationName: "matchPlayer1Design",
  }),
  player2Design: one(designs, {
    fields: [matches.player2DesignId],
    references: [designs.id],
    relationName: "matchPlayer2Design",
  }),
  rounds: many(rounds, { relationName: "matchRounds" }),
}));

export const roundsRelations = relations(rounds, ({ one }) => ({
  match: one(matches, {
    fields: [rounds.matchId],
    references: [matches.id],
    relationName: "matchRounds",
  }),
}));

export const adminUsersRelations = relations(adminUsers, ({ many }) => ({
  sessions: many(adminSessions, { relationName: "adminUserSessions" }),
  auditEntries: many(adminAudit, { relationName: "adminUserAudit" }),
  deletionEntries: many(deletionAudit, { relationName: "adminUserDeletions" }),
}));

export const adminSessionsRelations = relations(adminSessions, ({ one, many }) => ({
  adminUser: one(adminUsers, {
    fields: [adminSessions.adminUserId],
    references: [adminUsers.id],
    relationName: "adminUserSessions",
  }),
  auditEntries: many(adminAudit, { relationName: "adminSessionAudit" }),
}));

export const adminAuditRelations = relations(adminAudit, ({ one }) => ({
  adminUser: one(adminUsers, {
    fields: [adminAudit.adminUserId],
    references: [adminUsers.id],
    relationName: "adminUserAudit",
  }),
  adminSession: one(adminSessions, {
    fields: [adminAudit.adminSessionId],
    references: [adminSessions.id],
    relationName: "adminSessionAudit",
  }),
}));

export const deletionAuditRelations = relations(deletionAudit, ({ one }) => ({
  adminUser: one(adminUsers, {
    fields: [deletionAudit.adminUserId],
    references: [adminUsers.id],
    relationName: "adminUserDeletions",
  }),
}));

export type Identity = typeof identities.$inferSelect;
export type NewIdentity = typeof identities.$inferInsert;
export type Design = typeof designs.$inferSelect;
export type NewDesign = typeof designs.$inferInsert;
export type DesignLayer = typeof designLayers.$inferSelect;
export type NewDesignLayer = typeof designLayers.$inferInsert;
export type Match = typeof matches.$inferSelect;
export type NewMatch = typeof matches.$inferInsert;
export type Round = typeof rounds.$inferSelect;
export type NewRound = typeof rounds.$inferInsert;
