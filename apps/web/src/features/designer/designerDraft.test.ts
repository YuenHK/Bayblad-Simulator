import { describe, expect, it, vi } from "vitest";

import { makeDefaultDesign } from "@steam-top/domain";

import {
  DESIGNER_DRAFT_KEY,
  DESIGNER_DRAFT_VERSION,
  loadDesignerDraft,
  saveDesignerDraft,
} from "./designerDraft";

describe("designer draft persistence", () => {
  it("stores only the version and validated design", () => {
    const design = makeDefaultDesign();

    saveDesignerDraft(design);

    const raw = localStorage.getItem(DESIGNER_DRAFT_KEY);
    expect(raw).not.toBeNull();
    const payload = JSON.parse(raw!);
    expect(DESIGNER_DRAFT_VERSION).toBe(1);
    expect(Object.keys(payload).sort()).toEqual(["design", "version"]);
    expect(payload).toEqual({ version: 1, design });
  });

  it.each([
    "not-json",
    JSON.stringify({ version: 2, design: makeDefaultDesign() }),
    JSON.stringify({ version: 1, design: { name: "不完整" } }),
  ])("returns a fresh default for corrupt, mismatched, or invalid data", (raw) => {
    localStorage.setItem(DESIGNER_DRAFT_KEY, raw);

    const result = loadDesignerDraft();

    expect(result.name).toBe("我的陀螺");
    expect(result.layers).toHaveLength(3);
  });

  it("does not crash when storage access is unavailable", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked");
    });
    expect(() => loadDesignerDraft()).not.toThrow();
    getItem.mockRestore();

    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota");
    });
    expect(() => saveDesignerDraft(makeDefaultDesign())).not.toThrow();
    setItem.mockRestore();
  });
});
