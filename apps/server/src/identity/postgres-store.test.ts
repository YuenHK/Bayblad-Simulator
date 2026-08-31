import { describe, expect, it } from "vitest";
import { IdentityCapacityError, SessionTokenUnavailableError } from "./resolver";
import { runIdentityStoreStage } from "./postgres-store";

describe("identity store diagnostics", () => {
  it("adds a safe stage code while retaining the original failure", async () => {
    const failure = new Error("private database detail");
    const result = runIdentityStoreStage("IDENTITY_INSERT_FAILED", async () => { throw failure; });

    await expect(result).rejects.toMatchObject({
      name: "IdentityStoreStageError",
      code: "IDENTITY_INSERT_FAILED",
      cause: failure,
    });
  });

  it.each([new IdentityCapacityError(), new SessionTokenUnavailableError()])(
    "does not replace expected domain errors",
    async (failure) => {
      await expect(runIdentityStoreStage("IDENTITY_INSERT_FAILED", async () => { throw failure; })).rejects.toBe(failure);
    },
  );
});
