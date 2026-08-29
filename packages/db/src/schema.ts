import { relations, sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  date,
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
  varchar,
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
export const adminLoginScopeEnum = pgEnum("admin_login_scope", ["account", "client", "global"]);

export type BattleResultSnapshot = Readonly<Record<string, unknown>>;

export const identities = pgTable(
  "identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    status: identityStatusEnum("status").notNull(),
    displayName: varchar("display_name", { length: 80 }).notNull(),
    studentName: varchar("student_name", { length: 80 }),
    className: varchar("class_name", { length: 30 }),
    studentNumber: varchar("student_number", { length: 30 }),
    // Durable by user request, but never usable as an identity key.
    deviceName: varchar("device_name", { length: 128 }),
    anonymousDeviceId: uuid("anonymous_device_id").notNull().defaultRandom(),
    iclassExternalId: varchar("iclass_external_id", { length: 128 }),
    externalDeviceId: varchar("external_device_id", { length: 128 }),
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
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    lastIp: inet("last_ip"),
    userAgent: varchar("user_agent", { length: 512 }),
    // Diagnostic only; retained until explicit audited deletion or decommission.
  },
  (table) => [
    uniqueIndex("identity_sessions_token_hash_uidx").on(table.tokenHash),
    index("identity_sessions_identity_last_seen_idx").on(
      table.identityId,
      table.lastSeenAt,
    ),
    index("identity_sessions_active_expires_at_idx")
      .on(table.expiresAt)
      .where(sql`${table.revokedAt} is null`),
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

export const webClipTokenNonces = pgTable(
  "webclip_token_nonces",
  {
    jtiHash: text("jti_hash").primaryKey(),
    deviceId: varchar("device_id", { length: 128 }).notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    attemptHash: text("attempt_hash"),
    resultIdentityId: uuid("result_identity_id").references(() => identities.id),
    resultSessionId: uuid("result_session_id").references(() => identitySessions.id),
    resultTokenHash: text("result_token_hash"),
    committedAt: timestamp("committed_at", { withTimezone: true }),
  },
  (table) => [
    index("webclip_token_nonces_expiry_idx").on(table.expiresAt),
    check("webclip_token_nonces_jti_hash_format", sql`${table.jtiHash} ~ '^[a-f0-9]{64}$'`),
    check("webclip_token_nonces_expiry_after_issue", sql`${table.expiresAt} > ${table.issuedAt}`),
    check("webclip_token_nonces_result_consistent", sql`(${table.usedAt} is null and ${table.attemptHash} is null and ${table.resultIdentityId} is null and ${table.resultSessionId} is null and ${table.resultTokenHash} is null and ${table.committedAt} is null) or (${table.usedAt} is not null and ${table.attemptHash} ~ '^[a-f0-9]{64}$' and ${table.resultIdentityId} is not null and ${table.resultSessionId} is not null and ${table.resultTokenHash} ~ '^[a-f0-9]{64}$' and ${table.committedAt} is not null)`),
  ],
);

export const deviceActivityDays = pgTable("device_activity_days", {
  activityDate: date("activity_date").notNull(),
  anonymousDeviceId: uuid("anonymous_device_id").notNull(),
  identityId: uuid("identity_id").references(() => identities.id, { onDelete: "set null" }),
  identityStatusSnapshot: identityStatusEnum("identity_status_snapshot").notNull(),
  classNameSnapshot: varchar("class_name_snapshot", { length: 30 }),
  firstActivityAt: timestamp("first_activity_at", { withTimezone: true }).notNull(),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.activityDate, table.anonymousDeviceId] }),
  index("device_activity_days_identity_date_idx").on(table.identityId, table.activityDate),
  index("device_activity_days_filters_idx").on(table.activityDate, table.classNameSnapshot, table.identityStatusSnapshot),
  check("device_activity_days_time_order", sql`${table.lastActivityAt} >= ${table.firstActivityAt}`),
]);

export const analyticsDailySummaries = pgTable("analytics_daily_summaries", {
  summaryDate: date("summary_date").notNull(), filterHash: text("filter_hash").notNull(),
  filtersJson: jsonb("filters_json").$type<Readonly<Record<string, unknown>>>().notNull(),
  usageJson: jsonb("usage_json").$type<readonly unknown[]>().notNull(),
  usagePeriodsJson: jsonb("usage_periods_json").$type<Readonly<Record<string, unknown>>>().notNull(),
  parameterUsageJson: jsonb("parameter_usage_json").$type<readonly unknown[]>().notNull(),
  parametersJson: jsonb("parameters_json").$type<readonly unknown[]>().notNull(),
  rankingsJson: jsonb("rankings_json").$type<Readonly<Record<string, unknown>>>().notNull(),
  refreshedAt: timestamp("refreshed_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.summaryDate, table.filterHash] }), index("analytics_daily_summaries_refreshed_idx").on(table.refreshedAt),
  check("analytics_daily_summaries_hash_format", sql`${table.filterHash} ~ '^[a-f0-9]{64}$'`),
  check("analytics_daily_summaries_json_shape", sql`jsonb_typeof(${table.filtersJson})='object' and jsonb_typeof(${table.usageJson})='array' and jsonb_typeof(${table.usagePeriodsJson})='object' and jsonb_typeof(${table.parameterUsageJson})='array' and jsonb_typeof(${table.parametersJson})='array' and jsonb_typeof(${table.rankingsJson})='object'`),
]);

export const designs = pgTable(
  "designs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    logicalDesignId: uuid("logical_design_id").notNull(),
    ownerIdentityId: uuid("owner_identity_id").references(() => identities.id, {
      onDelete: "set null",
    }),
    version: integer("version").notNull(),
    schemaVersion: varchar("schema_version", { length: 64 }).notNull(),
    name: varchar("name", { length: 40 }).notNull(),
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
    performanceModelVersion: varchar("performance_model_version", {
      length: 64,
    }).notNull(),
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
      table.ownerIdentityId,
      table.logicalDesignId,
      table.version,
    ).where(sql`${table.ownerIdentityId} is not null`),
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
    sourceLayerId: varchar("source_layer_id", { length: 128 }).notNull(),
    layerOrder: smallint("layer_order").notNull(),
    position: topLayerPositionEnum("position").notNull(),
    shape: topShapeEnum("shape").notNull(),
    points: smallint("points").notNull(),
    diameterMm: numeric("diameter_mm", {
      precision: 7,
      scale: 3,
      mode: "number",
    }).notNull(),
    actualAreaMm2: numeric("actual_area_mm2", { precision: 12, scale: 4, mode: "number" }).notNull(),
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
    color: varchar("color", { length: 7 }).notNull(),
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
    check("design_layers_actual_area_positive", sql`${table.actualAreaMm2} > 0`),
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

export const designEventSnapshots = pgTable("design_event_snapshots", {
  designId: uuid("design_id").primaryKey().references(() => designs.id, { onDelete: "cascade" }),
  ownerIdentityIdAtCreation: uuid("owner_identity_id_at_creation"),
  canonicalIdentityIdAtCreation: uuid("canonical_identity_id_at_creation"),
  identityStatusSnapshot: identityStatusEnum("identity_status_snapshot"),
  classNameSnapshot: varchar("class_name_snapshot", { length: 30 }),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
}, (table) => [index("design_event_snapshots_filters_idx").on(table.capturedAt, table.classNameSnapshot, table.identityStatusSnapshot)]);

export const rooms = pgTable(
  "rooms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: varchar("code", { length: 32 }).notNull(),
    name: varchar("name", { length: 30 }).notNull(),
    ownerIdentityId: uuid("owner_identity_id").references(() => identities.id, {
      onDelete: "set null",
    }),
    status: roomStatusEnum("status").notNull().default("waiting"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    firstBattleAt: timestamp("first_battle_at", { withTimezone: true }),
    appliedProjectionRevision: bigint("applied_projection_revision", { mode: "number" }).notNull().default(-1),
    lastTransitionHash: varchar("last_transition_hash", { length: 64 }),
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
      sql`(${table.status} = 'closed') = (${table.closedAt} is not null)`,
    ),
    check("rooms_projection_revision", sql`${table.appliedProjectionRevision} >= -1`),
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
    participantPublicId: varchar("participant_public_id", { length: 32 }).notNull(),
    displayNameSnapshot: varchar("display_name_snapshot", { length: 80 }).notNull(),
    role: participantRoleEnum("role").notNull(),
    isOwner: boolean("is_owner").notNull().default(false),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leftAt: timestamp("left_at", { withTimezone: true }),
    lastIp: inet("last_ip"),
    userAgent: varchar("user_agent", { length: 512 }),
    deviceNameSnapshot: varchar("device_name_snapshot", { length: 128 }),
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

export const roomEventSnapshots = pgTable("room_event_snapshots", {
  roomId: uuid("room_id").primaryKey().references(() => rooms.id, { onDelete: "cascade" }), ownerIdentityIdAtCreation: uuid("owner_identity_id_at_creation"),
  canonicalIdentityIdAtCreation: uuid("canonical_identity_id_at_creation"), identityStatusSnapshot: identityStatusEnum("identity_status_snapshot"),
  classNameSnapshot: varchar("class_name_snapshot", { length: 30 }), capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
}, (table) => [index("room_event_snapshots_filters_idx").on(table.capturedAt, table.classNameSnapshot, table.identityStatusSnapshot)]);

export const roomProjectionJobs = pgTable(
  "room_projection_jobs",
  {
    roomId: uuid("room_id").primaryKey().references(() => rooms.id, { onDelete: "cascade" }),
    revision: bigint("revision", { mode: "number" }).notNull(),
    payloadHash: text("payload_hash").notNull(),
    payloadJson: jsonb("payload_json").$type<Readonly<Record<string, unknown>>>().notNull(),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    reservationToken: uuid("reservation_token"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    leaseToken: uuid("lease_token"),
    generation: integer("generation").notNull().default(0),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    lastError: varchar("last_error", { length: 128 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("room_projection_jobs_due_idx").on(table.status, table.nextAttemptAt, table.createdAt),
    check("room_projection_jobs_revision", sql`${table.revision} >= 0`),
    check("room_projection_jobs_payload_hash", sql`${table.payloadHash} ~ '^[a-f0-9]{64}$'`),
    check("room_projection_jobs_status", sql`${table.status} in ('prepared','pending','leased','dead','aborted')`),
    check("room_projection_jobs_attempts", sql`${table.attemptCount} >= 0 and ${table.generation} >= 0`),
    check("room_projection_jobs_lease", sql`(${table.status} = 'leased' and ${table.leaseToken} is not null and ${table.leaseUntil} is not null) or (${table.status} <> 'leased' and ${table.leaseToken} is null and ${table.leaseUntil} is null)`),
    check("room_projection_jobs_reservation", sql`(${table.status} = 'prepared' and ${table.reservationToken} is not null) or (${table.status} <> 'prepared' and ${table.reservationToken} is null)`),
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
    performanceModelVersion: varchar("performance_model_version", { length: 64 }).notNull(),
    physicsModelVersion: varchar("physics_model_version", { length: 64 }).notNull(),
    protocolVersion: smallint("protocol_version").notNull(),
    spectatorCount: integer("spectator_count").notNull().default(0),
    player1Ip: inet("player1_ip"),
    player2Ip: inet("player2_ip"),
    player1UserAgent: varchar("player1_user_agent", { length: 512 }),
    player2UserAgent: varchar("player2_user_agent", { length: 512 }),
    player1DeviceName: varchar("player1_device_name", { length: 128 }),
    player2DeviceName: varchar("player2_device_name", { length: 128 }),
    persistFailureCode: varchar("persist_failure_code", { length: 128 }),
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
      "matches_battle_points_range",
      sql`(${table.player1BattlePoints} is null or ${table.player1BattlePoints} between 0 and 2) and (${table.player2BattlePoints} is null or ${table.player2BattlePoints} between 0 and 2)`,
    ),
    check(
      "matches_round_winners_shape",
      sql`${table.roundWinners} is null or (jsonb_typeof(${table.roundWinners}) = 'array' and jsonb_array_length(${table.roundWinners}) between 2 and 3 and ${table.roundWinners} <@ '["player1","player2"]'::jsonb)`,
    ),
    check(
      "matches_completed_score_shape",
      sql`${table.status} <> 'completed' or (${table.completedAt} is not null and ${table.winner} is not null and ${table.player1BattlePoints} is not null and ${table.player2BattlePoints} is not null and ${table.player1ChallengePoints} is not null and ${table.player2ChallengePoints} is not null and ${table.player1Total} is not null and ${table.player2Total} is not null and ${table.roundWinners} is not null and jsonb_typeof(${table.roundWinners}) = 'array' and ((${table.winner} = 'player1' and ${table.player1BattlePoints} = 2 and ${table.player2BattlePoints} = 0 and ${table.roundWinners} = '["player1","player1"]'::jsonb) or (${table.winner} = 'player1' and ${table.player1BattlePoints} = 2 and ${table.player2BattlePoints} = 1 and ${table.roundWinners} in ('["player1","player2","player1"]'::jsonb, '["player2","player1","player1"]'::jsonb)) or (${table.winner} = 'player2' and ${table.player2BattlePoints} = 2 and ${table.player1BattlePoints} = 0 and ${table.roundWinners} = '["player2","player2"]'::jsonb) or (${table.winner} = 'player2' and ${table.player2BattlePoints} = 2 and ${table.player1BattlePoints} = 1 and ${table.roundWinners} in ('["player1","player2","player2"]'::jsonb, '["player2","player1","player2"]'::jsonb))))`,
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
    externalRoundId: varchar("external_round_id", { length: 128 }).notNull(),
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
    physicsModelVersion: varchar("physics_model_version", { length: 64 }).notNull(),
    inputFingerprint: text("input_fingerprint").notNull(),
    battleResultJson: jsonb("battle_result_json")
      .$type<BattleResultSnapshot>()
      .notNull(),
    framesStrategy: varchar("frames_strategy", { length: 32 }).notNull().default("full_json_v1"),
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
    uniqueIndex("rounds_match_external_round_id_uidx").on(
      table.matchId,
      table.externalRoundId,
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
    check(
      "rounds_battle_result_shape",
      sql`jsonb_typeof(${table.battleResultJson}) = 'object' and ${table.battleResultJson} ?& array['modelVersion','seed','ticks','frames','outcome','finalStats'] and jsonb_typeof(${table.battleResultJson}->'modelVersion') = 'string' and length(btrim(${table.battleResultJson}->>'modelVersion')) > 0 and ${table.battleResultJson}->>'modelVersion' = ${table.physicsModelVersion} and jsonb_typeof(${table.battleResultJson}->'seed') = 'number' and (${table.battleResultJson}->>'seed')::numeric = trunc((${table.battleResultJson}->>'seed')::numeric) and (${table.battleResultJson}->>'seed')::numeric between -9007199254740991 and 9007199254740991 and (${table.battleResultJson}->>'seed')::numeric = ${table.seed}::numeric and jsonb_typeof(${table.battleResultJson}->'ticks') = 'number' and (${table.battleResultJson}->>'ticks')::numeric = trunc((${table.battleResultJson}->>'ticks')::numeric) and (${table.battleResultJson}->>'ticks')::numeric between 0 and 5400 and (${table.battleResultJson}->>'ticks')::numeric = ${table.ticks}::numeric and jsonb_typeof(${table.battleResultJson}->'frames') = 'array' and jsonb_typeof(${table.battleResultJson}->'finalStats') = 'object' and jsonb_typeof(${table.battleResultJson}->'outcome') = 'object' and ${table.battleResultJson}->'outcome' ?& array['winner','reason'] and ${table.battleResultJson}->'outcome'->>'winner' = ${table.outcome}::text and ${table.battleResultJson}->'outcome'->>'reason' = ${table.outcomeReason}::text`,
    ),
  ],
);

export const matchParticipantSnapshots = pgTable("match_participant_snapshots", {
  matchId: uuid("match_id").notNull().references(() => matches.id, { onDelete: "cascade" }),
  slot: playerSlotEnum("slot").notNull(),
  identityIdAtStart: uuid("identity_id_at_start"),
  canonicalIdentityIdAtStart: uuid("canonical_identity_id_at_start"),
  identityStatusSnapshot: identityStatusEnum("identity_status_snapshot"),
  classNameSnapshot: varchar("class_name_snapshot", { length: 30 }),
  designId: uuid("design_id").notNull().references(() => designs.id, { onDelete: "restrict" }),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.matchId, table.slot] }),
  index("match_participant_snapshots_filters_idx").on(table.capturedAt, table.classNameSnapshot, table.identityStatusSnapshot),
  index("match_participant_snapshots_canonical_idx").on(table.canonicalIdentityIdAtStart, table.capturedAt),
]);

/** Durable authority for deterministic physics before a completed match exists. */
export const battleResults = pgTable(
  "battle_results",
  {
    authorityKeyHash: text("authority_key_hash").primaryKey(),
    correlationKey: varchar("correlation_key", { length: 264 }).notNull(),
    inputFingerprint: text("input_fingerprint").notNull(),
    resultJson: jsonb("result_json").$type<BattleResultSnapshot>(),
    resultBytes: integer("result_bytes"),
    claimOwner: uuid("claim_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("battle_results_correlation_key_uidx").on(table.correlationKey),
    index("battle_results_lease_idx").on(table.leaseExpiresAt),
    check("battle_results_authority_hash_format", sql`${table.authorityKeyHash} ~ '^[a-f0-9]{64}$'`),
    check("battle_results_input_hash_format", sql`${table.inputFingerprint} ~ '^[a-f0-9]{64}$'`),
    check("battle_results_size", sql`${table.resultBytes} is null or ${table.resultBytes} between 1 and 2097152`),
    check("battle_results_state", sql`(${table.resultJson} is null and ${table.completedAt} is null and ${table.claimOwner} is not null and ${table.leaseExpiresAt} is not null) or (${table.resultJson} is not null and ${table.resultBytes} is not null and ${table.completedAt} is not null and ${table.claimOwner} is null and ${table.leaseExpiresAt} is null)`),
  ],
);

export const matchPersistenceJobs = pgTable(
  "match_persistence_jobs",
  {
    matchId: uuid("match_id").primaryKey().references(() => matches.id, { onDelete: "cascade" }),
    inputFingerprint: text("input_fingerprint").notNull(),
    completionPayload: jsonb("completion_payload").$type<Readonly<Record<string, unknown>>>().notNull(),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }).notNull().defaultNow(),
    claimToken: uuid("claim_token"),
    generation: integer("generation").notNull().default(0),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    lastSanitizedCode: varchar("last_sanitized_code", { length: 128 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("match_persistence_jobs_due_idx").on(table.status, table.nextRetryAt),
    check("match_persistence_jobs_fingerprint_format", sql`${table.inputFingerprint} ~ '^[a-f0-9]{64}$'`),
    check("match_persistence_jobs_status", sql`${table.status} in ('pending','retrying','failed','completed')`),
    check("match_persistence_jobs_attempts", sql`${table.attemptCount} >= 0`),
    check("match_persistence_jobs_claim", sql`(${table.status} = 'retrying' and ${table.claimToken} is not null and ${table.leaseUntil} is not null) or (${table.status} <> 'retrying' and ${table.claimToken} is null and ${table.leaseUntil} is null)`),
    check("match_persistence_jobs_completion", sql`(${table.status} = 'completed' and ${table.completedAt} is not null and ${table.lastSanitizedCode} is null) or (${table.status} <> 'completed' and ${table.completedAt} is null)`),
  ],
);

export const adminUsers = pgTable(
  "admin_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    username: varchar("username", { length: 80 }).notNull(),
    passwordHash: text("password_hash").notNull(),
    active: boolean("active").notNull().default(true),
    mustChangePassword: boolean("must_change_password").notNull().default(false),
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
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    lastIp: inet("last_ip"),
    userAgent: varchar("user_agent", { length: 512 }),
  },
  (table) => [
    uniqueIndex("admin_sessions_token_hash_uidx").on(table.tokenHash),
    index("admin_sessions_admin_last_seen_idx").on(
      table.adminUserId,
      table.lastSeenAt,
    ),
    index("admin_sessions_expires_at_idx").on(table.expiresAt),
    index("admin_sessions_active_idx").on(table.adminUserId, table.expiresAt, table.archivedAt),
    check(
      "admin_sessions_token_hash_format",
      sql`${table.tokenHash} ~ '^[a-f0-9]{64}$' and ${table.csrfTokenHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "admin_sessions_expiry_after_creation",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    check("admin_sessions_archive_requires_revoke", sql`${table.archivedAt} is null or ${table.revokedAt} is not null`),
  ],
);

export const adminLoginLimits = pgTable("admin_login_limits", {
  scope: adminLoginScopeEnum("scope").notNull(), keyHash: text("key_hash").notNull(), failureCount: integer("failure_count").notNull().default(0), windowStart: timestamp("window_start", { withTimezone: true }).notNull(), lockedUntil: timestamp("locked_until", { withTimezone: true }), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.scope, table.keyHash] }), index("admin_login_limits_updated_idx").on(table.updatedAt), check("admin_login_limits_hash_format", sql`${table.keyHash} ~ '^[a-f0-9]{64}$'`), check("admin_login_limits_count_nonnegative", sql`${table.failureCount} >= 0`), check("admin_login_limits_lock_order", sql`${table.lockedUntil} is null or ${table.lockedUntil} >= ${table.windowStart}`)]);

export const adminReauthGrants = pgTable("admin_reauth_grants", {
  id: uuid("id").primaryKey().defaultRandom(), adminUserId: uuid("admin_user_id").notNull().references(() => adminUsers.id, { onDelete: "cascade" }), adminSessionId: uuid("admin_session_id").notNull().references(() => adminSessions.id, { onDelete: "cascade" }), tokenHash: text("token_hash").notNull(), purpose: varchar("purpose", { length: 64 }).notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), consumedAt: timestamp("consumed_at", { withTimezone: true }),
}, (table) => [uniqueIndex("admin_reauth_grants_token_uidx").on(table.tokenHash), index("admin_reauth_grants_expiry_idx").on(table.expiresAt), check("admin_reauth_grants_hash_format", sql`${table.tokenHash} ~ '^[a-f0-9]{64}$'`), check("admin_reauth_grants_purpose_nonblank", sql`length(btrim(${table.purpose})) between 1 and 64`), check("admin_reauth_grants_time_order", sql`${table.expiresAt} > ${table.createdAt} and (${table.consumedAt} is null or (${table.consumedAt} >= ${table.createdAt} and ${table.consumedAt} <= ${table.expiresAt}))`)]);

export const adminAudit = pgTable(
  "admin_audit",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    adminUserId: uuid("admin_user_id").references(() => adminUsers.id, {
      onDelete: "restrict",
    }),
    adminSessionId: uuid("admin_session_id"),
    action: varchar("action", { length: 128 }).notNull(),
    targetType: varchar("target_type", { length: 64 }),
    targetId: varchar("target_id", { length: 128 }),
    outcome: auditOutcomeEnum("outcome").notNull(),
    details: jsonb("details").$type<Readonly<Record<string, unknown>>>().notNull().default({}),
    requestIp: inet("request_ip"),
    userAgent: varchar("user_agent", { length: 512 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    sourceOutboxId: uuid("source_outbox_id"),
  },
  (table) => [
    index("admin_audit_created_at_idx").on(table.createdAt),
    index("admin_audit_admin_action_idx").on(
      table.adminUserId,
      table.action,
      table.createdAt,
    ),
    index("admin_audit_target_idx").on(table.targetType, table.targetId),
    uniqueIndex("admin_audit_source_outbox_uidx").on(table.sourceOutboxId).where(sql`${table.sourceOutboxId} is not null`),
  ],
);

export const adminAuditOutbox = pgTable("admin_audit_outbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  payload: jsonb("payload").$type<Readonly<Record<string, unknown>>>().notNull(),
  attemptCount: integer("attempt_count").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  lastError: varchar("last_error", { length: 128 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("admin_audit_outbox_due_idx").on(table.nextAttemptAt, table.createdAt), check("admin_audit_outbox_attempts", sql`${table.attemptCount} >= 0`)]);

export const deletionAudit = pgTable(
  "deletion_audit",
  {
    id: uuid("id").primaryKey(),
    adminUserId: uuid("admin_user_id").references(() => adminUsers.id, {
      onDelete: "set null",
    }),
    scope: deletionScopeEnum("scope").notNull(),
    filterHash: text("filter_hash").notNull(),
    previewCount: integer("preview_count").notNull(),
    deletedIdentityCount: integer("deleted_identity_count").notNull(),
    deletedDesignCount: integer("deleted_design_count").notNull(),
    deletedMatchCount: integer("deleted_match_count").notNull(),
    transactionId: bigint("transaction_id", { mode: "bigint" })
      .notNull()
      .default(sql`txid_current()`),
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
  deviceActivityDays: many(deviceActivityDays),
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
  eventSnapshot: one(designEventSnapshots),
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
export const designEventSnapshotsRelations = relations(designEventSnapshots, ({ one }) => ({ design: one(designs, { fields: [designEventSnapshots.designId], references: [designs.id] }) }));
export const deviceActivityDaysRelations = relations(deviceActivityDays, ({ one }) => ({ identity: one(identities, { fields: [deviceActivityDays.identityId], references: [identities.id] }) }));

export const roomsRelations = relations(rooms, ({ one, many }) => ({
  ownerIdentity: one(identities, {
    fields: [rooms.ownerIdentityId],
    references: [identities.id],
    relationName: "ownedRooms",
  }),
  participants: many(roomParticipants, { relationName: "roomParticipants" }),
  matches: many(matches, { relationName: "roomMatches" }),
  eventSnapshot: one(roomEventSnapshots),
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
export const roomEventSnapshotsRelations = relations(roomEventSnapshots, ({ one }) => ({ room: one(rooms, { fields: [roomEventSnapshots.roomId], references: [rooms.id] }) }));

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
  participantSnapshots: many(matchParticipantSnapshots),
}));

export const roundsRelations = relations(rounds, ({ one }) => ({
  match: one(matches, {
    fields: [rounds.matchId],
    references: [matches.id],
    relationName: "matchRounds",
  }),
}));
export const matchParticipantSnapshotsRelations = relations(matchParticipantSnapshots, ({ one }) => ({
  match: one(matches, { fields: [matchParticipantSnapshots.matchId], references: [matches.id] }),
  design: one(designs, { fields: [matchParticipantSnapshots.designId], references: [designs.id] }),
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
