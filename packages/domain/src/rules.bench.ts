import { bench, describe } from "vitest";

import { makeDefaultDesign, type TopDesign } from "./design";
import { validateDesign } from "./rules";

const defaultDesign = makeDefaultDesign();
const worstInvalidDesign = makeDefaultDesign();
worstInvalidDesign.layers = worstInvalidDesign.layers.map((layer) => ({
  ...layer,
  shape: "star",
  points: 16,
  diameterMm: 20,
  cornerRoundness: 0,
})) as TopDesign["layers"];
worstInvalidDesign.screwLayout = {
  count: 8,
  radiusMm: 5,
  rotationDeg: 11,
};

describe("validateDesign", () => {
  bench("default analytic-circle design", () => {
    validateDesign(defaultDesign);
  });

  bench("worst invalid schema-valid draft", () => {
    validateDesign(worstInvalidDesign);
  });
});
