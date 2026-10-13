import { renderHook, act } from "@testing-library/react";
import { expect, it } from "vitest";
import { makeDefaultDesign } from "@steam-top/domain";
import { useDesigner } from "../designer/useDesigner";
import { DESIGNER_DRAFT_KEY } from "../designer/designerDraft";

it("editing a practice copy never replaces the formal stored draft", () => {
  localStorage.setItem(DESIGNER_DRAFT_KEY, "original");
  const initialDesign = makeDefaultDesign();
  const { result, unmount } = renderHook(() => useDesigner({ initialDesign, persistDraft: false }));
  act(() => result.current.dispatch({ type: "update-layer", position: "top", field: "diameterMm", value: 41 }));
  expect(result.current.design.layers[0].diameterMm).toBe(41);
  expect(localStorage.getItem(DESIGNER_DRAFT_KEY)).toBe("original");
  expect(initialDesign.layers[0].diameterMm).not.toBe(41);
  unmount();
  localStorage.removeItem(DESIGNER_DRAFT_KEY);
});
