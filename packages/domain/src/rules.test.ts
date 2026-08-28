import { describe, expect, it } from "vitest";

import { makeDefaultDesign, type TopDesign } from "./design";
import { makeLayerVertices } from "./geometry";
import { ASSEMBLY } from "./mass";
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
  it("accepts the default design without issues", () => {
    const result = validateDesign(makeDefaultDesign());

    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

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
  it("accepts an equal circle disc and rejects one 0.01 mm larger", () => {
    const exactFit = designWithAllLayers({});
    exactFit.layers[2].diameterMm = 50;
    exactFit.metalDiscDiameterMm = 50;
    const oversized = structuredClone(exactFit);
    oversized.metalDiscDiameterMm = 50.01;

    expect(issueCodes(exactFit)).not.toContain(
      "METAL_DISC_OUTSIDE_BOTTOM",
    );
    expect(issueCodes(oversized)).toContain("METAL_DISC_OUTSIDE_BOTTOM");
  });

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
  it.each([
    [17.999, false, true],
    [18, false, true],
    [18.000001, true, false],
  ] as const)(
    "classifies a circle screw radius %s continuously at the boundary",
    (radiusMm, outside, neck) => {
      const design = designWithAllLayers({ diameterMm: 40 });
      design.screwLayout.radiusMm = radiusMm;
      const codes = issueCodes(design);

      expect(codes.includes("SCREW_OUTSIDE_LAYER")).toBe(outside);
      expect(codes.includes("NECK_TOO_THIN")).toBe(neck);
    },
  );

  it("reports a tangent neck and then an outside hole on a polygon layer", () => {
    const design = designWithAllLayers({});
    design.layers[0] = {
      ...design.layers[0],
      shape: "polygon",
      points: 4,
      diameterMm: 40,
      cornerRoundness: 0,
      rotationDeg: 0,
    };
    const vertices = makeLayerVertices(design.layers[0]);
    const distanceToSegment = (
      point: { x: number; y: number },
      start: { x: number; y: number },
      end: { x: number; y: number },
    ) => {
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const lengthSquared = dx ** 2 + dy ** 2;
      const projection = Math.max(
        0,
        Math.min(
          1,
          ((point.x - start.x) * dx + (point.y - start.y) * dy) /
            lengthSquared,
        ),
      );
      return Math.hypot(
        point.x - start.x - projection * dx,
        point.y - start.y - projection * dy,
      );
    };
    const clearance = (radiusMm: number) =>
      Math.min(
        ...vertices.map((start, index) =>
          distanceToSegment(
            { x: radiusMm, y: 0 },
            start,
            vertices[(index + 1) % vertices.length] ?? start,
          ),
        ),
      ) - ASSEMBLY.screwHoleRadiusMm;
    let inside = 0;
    let outside = 20;
    for (let iteration = 0; iteration < 80; iteration += 1) {
      const midpoint = (inside + outside) / 2;
      if (clearance(midpoint) >= 0) {
        inside = midpoint;
      } else {
        outside = midpoint;
      }
    }

    design.screwLayout.radiusMm = inside;
    expect(issueCodes(design)).toContain("NECK_TOO_THIN");
    expect(issueCodes(design)).not.toContain("SCREW_OUTSIDE_LAYER");
    design.screwLayout.radiusMm = outside + 0.000001;
    expect(issueCodes(design)).toContain("SCREW_OUTSIDE_LAYER");
  });

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
