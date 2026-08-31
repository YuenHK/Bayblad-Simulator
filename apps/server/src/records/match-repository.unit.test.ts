import { expect, it } from "vitest";
import { runMatchBeginStage } from "./match-repository";

it("retains a safe match-begin stage code and the original failure", async () => {
  const cause = new Error("private database detail");
  await expect(runMatchBeginStage("MATCH_BEGIN_SNAPSHOT_INSERT_FAILED", async () => { throw cause; })).rejects.toMatchObject({
    name: "MatchBeginStageError",
    code: "MATCH_BEGIN_SNAPSHOT_INSERT_FAILED",
    cause,
  });
});
