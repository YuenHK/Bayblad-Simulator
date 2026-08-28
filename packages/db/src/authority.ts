import { createHash } from "node:crypto";

const MAX_CORRELATION_LENGTH = 128;
const CORRELATION_COMPONENT = /^[A-Za-z0-9_-]+$/;

/** Must remain byte-for-byte aligned with BattleEngine's ResultRepository key. */
export function battleCorrelationKey(matchId: string, externalRoundId: string): string {
  for (const value of [matchId, externalRoundId]) {
    if (
      value.length < 1 ||
      value.length > MAX_CORRELATION_LENGTH ||
      !CORRELATION_COMPONENT.test(value)
    ) {
      throw new RangeError("Invalid correlation key");
    }
  }
  return `${matchId.length}:${matchId}${externalRoundId.length}:${externalRoundId}`;
}

export function battleAuthorityKeyHash(
  matchId: string,
  externalRoundId: string,
): string {
  return createHash("sha256")
    .update(battleCorrelationKey(matchId, externalRoundId), "utf8")
    .digest("hex");
}
