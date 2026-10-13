import { expect, it } from "vitest";
import { makeDefaultDesign } from "@steam-top/domain";
import { createNotebook, copyVersion } from "./notebook";
import { canAdvanceTutorial } from "./tutorial";

it("requires student actions rather than just clicking next", () => {
  const original = makeDefaultDesign();
  const book = createNotebook(original);
  expect(canAdvanceTutorial(0, book, original)).toBe(false);
  book.versions[0]!.draft.layers[0] = { ...original.layers[0], diameterMm: 42 };
  expect(canAdvanceTutorial(0, book, original)).toBe(true);
  expect(canAdvanceTutorial(1, book, original)).toBe(false);
  const copied = copyVersion(book, "A");
  copied.versions[1]!.draft.layers[0] = { ...copied.versions[1]!.draft.layers[0], diameterMm: 43 };
  expect(canAdvanceTutorial(1, copied, original)).toBe(true);
  expect(canAdvanceTutorial(2, copied, original)).toBe(false);
  expect(canAdvanceTutorial(3, copied, original)).toBe(false);
});
