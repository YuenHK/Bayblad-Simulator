import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "./schema";

export type SimulatorDatabase = PostgresJsDatabase<typeof schema>;

/**
 * Builds the teacher/export read model from immutable snapshots.  Keeping the
 * builder public lets static tests compile and inspect the exact PostgreSQL
 * query without creating a network connection.
 */
export function buildMatchWithDetailsQuery(
  db: SimulatorDatabase,
  matchId: string,
) {
  return db.query.matches.findFirst({
    where: (match, { eq }) => eq(match.id, matchId),
    with: {
      player1Identity: true,
      player2Identity: true,
      player1Design: {
        with: {
          layers: {
            orderBy: (layer, { asc }) => [asc(layer.layerOrder)],
          },
        },
      },
      player2Design: {
        with: {
          layers: {
            orderBy: (layer, { asc }) => [asc(layer.layerOrder)],
          },
        },
      },
      rounds: {
        orderBy: (round, { asc }) => [
          asc(round.roundNumber),
          asc(round.attempt),
        ],
      },
    },
  });
}

export type MatchWithDetails = NonNullable<
  Awaited<ReturnType<ReturnType<typeof buildMatchWithDetailsQuery>["execute"]>>
>;

export async function matchWithDetails(
  db: SimulatorDatabase,
  matchId: string,
): Promise<MatchWithDetails | undefined> {
  return buildMatchWithDetailsQuery(db, matchId).execute();
}
