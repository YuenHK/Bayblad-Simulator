import { expect, it } from "vitest";
import { makeDefaultDesign } from "./design";
import { validateDesign, validateMassLimit } from "./rules";
import { makeLayerMaterialPolygons } from "./mass";

it("admits lightweight geometry regardless of former fabrication restrictions", () => {
  const design = makeDefaultDesign();
  design.layers[0].diameterMm = 65;
  design.layers[1].diameterMm = 20;
  design.layers[2].diameterMm = 20;
  design.screwLayout.radiusMm = 25;
  design.metalDiscDiameterMm = 30;
  const validation = validateDesign(design);
  expect(validation.massProperties.totalMassG).toBeLessThan(60);
  expect(validation.valid).toBe(true);
  expect(validation.issues).toEqual([]);
});
it("keeps the exact weight boundary and malformed-input checks", () => {
  expect(validateMassLimit(60)).toEqual([]);
  expect(validateMassLimit(60.001)[0]?.code).toBe("WEIGHT_OVER_60");
  const design = makeDefaultDesign();
  design.layers[0].diameterMm = NaN;
  expect(() => validateDesign(design)).toThrow();
});
it("clips protruding and overlapping holes into renderable material contours",()=>{
  const design=makeDefaultDesign();
  design.layers[0].diameterMm=20;
  design.screwLayout.radiusMm=10;
  const polygons=makeLayerMaterialPolygons(design.layers[0],design);
  expect(polygons.length).toBeGreaterThan(0);
  for (const polygon of polygons) for (const ring of polygon) for (const [x,y] of ring) {
    expect(Number.isFinite(x)&&Number.isFinite(y)).toBe(true);
    expect(Math.hypot(x,y)).toBeLessThan(10.01);
  }
});
