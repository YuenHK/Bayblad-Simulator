import type { DatabaseClient } from "@steam-top/db";
import { PostgresBattleResultRepository } from "./battle-result-repository";
import { PostgresDesignRepository } from "./design-repository";
import { PostgresMatchRepository } from "./match-repository";
import { PostgresRoomRecordRepository } from "./room-repository";
import { PostgresRoomProjectionStore } from "./room-projection-store";

/** The only production record composition; memory stores are deliberately absent. */
export function createProductionRecordRepositories(db: DatabaseClient["db"]) {
  return Object.freeze({
    designRepository: new PostgresDesignRepository(db),
    matchRepository: new PostgresMatchRepository(db),
    roomRecordRepository: new PostgresRoomRecordRepository(db),
    roomProjectionStore: new PostgresRoomProjectionStore(db),
    resultRepository: new PostgresBattleResultRepository(db),
  });
}
