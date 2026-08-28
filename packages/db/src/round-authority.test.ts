import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { rounds } from "./schema";

describe("authoritative completed rounds", () => {
  it("stores the external round id separately from its authority and input hashes", () => {
    const config = getTableConfig(rounds);
    expect(config.columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "external_round_id",
        "authority_key_hash",
        "input_fingerprint",
      ]),
    );
    expect(config.columns.map(({ name }) => name)).not.toContain(
      "result_fingerprint",
    );
  });
});
