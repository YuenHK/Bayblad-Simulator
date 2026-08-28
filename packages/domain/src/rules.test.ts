import { describe, expect, it } from "vitest";

import { makeDefaultDesign, type TopDesign } from "./design";
import {
  validateDesign,
  validateHeightLimit,
  validateMassLimit,
  type RuleIssueCode,
} from "./rules";

function designWithAllLayers(
  change: Partial<TopDesign["layers"][number]>,
): TopDesign {
  const design = makeDefaultDesign();
  return {
    ...design,
    layers: design.layers.map((layer) => ({
      ...layer,
      shape: "circle",
      diameterMm: 60,
      ...change,
    })) as TopDesign["layers"],
    screwLayout: { count: 4, radiusMm: 15, rotationDeg: 0 },
    metalDiscDiameterMm: 0,
  };
}

function issueCodes(design: TopDesign): RuleIssueCode[] {
  return validateDesign(design).issues.map(({ code }) => code);
}

describe("course boundaries", () => {
  it("accepts 60 mm and reports 60.01 mm as a course-rule issue", () => {
    expect(issueCodes(designWithAllLayers({ diameterMm: 60 }))).not.toContain(
      "DIAMETER_OVER_60",
    );
    expect(issueCodes(designWithAllLayers({ diameterMm: 60.01 }))).toContain(
      "DIAMETER_OVER_60",
    );
  });

  it("accepts exactly 60 g and rejects 60.01 g through a pure helper", () => {
    expect(validateMassLimit(60)).toEqual([]);
    expect(validateMassLimit(60.01).map(({ code }) => code)).toEqual([
      "WEIGHT_OVER_60",
    ]);
  });

  it("keeps the fixed design height below the limit and tests its boundary", () => {
    expect(validateHeightLimit(40)).toEqual([]);
    expect(validateHeightLimit(40.01).map(({ code }) => code)).toEqual([
      "HEIGHT_OVER_40",
    ]);
    expect(issueCodes(designWithAllLayers({}))).not.toContain("HEIGHT_OVER_40");
    expect(
      issueCodes({ ...designWithAllLayers({}), metalDiscDiameterMm: 10 }),
    ).not.toContain("HEIGHT_OVER_40");
  });
});

describe("metal-disc fit", () => {
  it("reports a 55 mm disc under a 50 mm circular bottom layer", () => {
    const design = designWithAllLayers({});
    design.layers[2].diameterMm = 50;
    design.metalDiscDiameterMm = 55;

    expect(issueCodes(design)).toContain("METAL_DISC_OUTSIDE_BOTTOM");
  });

  it.each(["star", "wave"] as const)(
    "uses the concave %s profile rather than nominal diameter",
    (shape) => {
      const design = designWithAllLayers({});
      design.layers[2] = {
        ...design.layers[2],
        shape,
        points: 6,
        diameterMm: 55,
        cornerRoundness: 0,
      };
      design.metalDiscDiameterMm = shape === "star" ? 40 : 54;

      expect(design.metalDiscDiameterMm).toBeLessThanOrEqual(
        design.layers[2].diameterMm,
      );
      expect(issueCodes(design)).toContain("METAL_DISC_OUTSIDE_BOTTOM");
    },
  );
});

describe("screw and material safety", () => {
  it("reports screw holes outside any layer", () => {
    const design = designWithAllLayers({ diameterMm: 40 });
    design.screwLayout.radiusMm = 25;

    expect(issueCodes(design)).toContain("SCREW_OUTSIDE_LAYER");
  });

  it("reports screw holes that hit the axle", () => {
    const design = designWithAllLayers({});
    design.screwLayout.radiusMm = 5;

    expect(issueCodes(design)).toContain("SCREW_HITS_AXLE");
  });

  it("reports a neck narrower than the material safety margin", () => {
    const design = designWithAllLayers({ diameterMm: 40 });
    design.screwLayout.radiusMm = 16.01;

    expect(issueCodes(design)).toContain("NECK_TOO_THIN");
  });

  it("returns complete issues with non-empty Traditional Chinese messages", () => {
    const design = designWithAllLayers({ diameterMm: 60.01 });
    design.screwLayout.radiusMm = 25;
    const result = validateDesign(design);

    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    for (const issue of result.issues) {
      expect(issue).toEqual({
        code: expect.any(String),
        layerId: expect.toSatisfy(
          (value: unknown) => value === null || typeof value === "string",
        ),
        field: expect.any(String),
        message: expect.stringMatching(/[\u3400-\u9fff]/),
      });
      expect(issue.field).not.toBe("");
      expect(issue.message).not.toBe("");
    }
    expect(
      [
        result.massProperties.totalMassG,
        result.massProperties.centerOfMassMm.x,
        result.massProperties.centerOfMassMm.y,
        result.massProperties.polarMomentGmm2,
      ].every(Number.isFinite),
    ).toBe(true);
  });

  it("does not mutate its input", () => {
    const design = designWithAllLayers({ diameterMm: 60.01 });
    const before = structuredClone(design);

    validateDesign(design);

    expect(design).toEqual(before);
  });
});
