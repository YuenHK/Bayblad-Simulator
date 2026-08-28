import { describe, expect, it } from "vitest";
import { designUploadResponseSchema } from "./api-contracts";
import { makeDefaultDesign } from "./design";
import { predictDesignPerformance } from "./performance";
import { validateDesign } from "./rules";

describe("design upload response contract", () => {
  it("接受權威domain計算結果並strict拒絕額外欄位", () => {
    const design = makeDefaultDesign();
    const response = { designId: crypto.randomUUID(), massG: validateDesign(design).massProperties.totalMassG, performance: predictDesignPerformance(design) };
    expect(designUploadResponseSchema.parse(response)).toEqual(response);
    expect(designUploadResponseSchema.safeParse({ ...response, ownerSessionId: "secret" }).success).toBe(false);
  });
});
