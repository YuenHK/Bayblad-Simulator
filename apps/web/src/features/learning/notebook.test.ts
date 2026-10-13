import { describe, expect, it } from "vitest";
import { makeDefaultDesign } from "@steam-top/domain";
import { createNotebook, copyVersion, designDifferences, loadNotebook, notebookCsv } from "./notebook";

describe("isolated learning notebook", () => {
  it("copies geometry without sharing objects or changing the source", () => {
    const source = makeDefaultDesign();
    const book = copyVersion(createNotebook(source), "A");
    expect(book.versions.map(v => v.label)).toEqual(["A", "B"]);
    expect(book.versions[1]!.draft).toEqual(source);
    expect(book.versions[1]!.draft).not.toBe(source);
    expect(designDifferences(book.versions[0]!.draft, book.versions[1]!.draft)).toEqual([]);
  });
  it("ignores cosmetic metadata and reports a single diameter change", () => {
    const a = makeDefaultDesign();
    const b = structuredClone(a);
    b.layers[0] = { ...b.layers[0], diameterMm: b.layers[0].diameterMm + 1, color: "#ffffff" };
    expect(designDifferences(a, b)).toHaveLength(1);
    expect(designDifferences(a, b)[0]).toContain("直徑");
  });
  it("preserves unreadable or future stored data instead of overwriting", () => {
    const result = loadNotebook('{"version":99}', makeDefaultDesign());
    expect(result.writable).toBe(false);
    expect(result.notebook.versions).toHaveLength(1);
    expect(loadNotebook(null, makeDefaultDesign()).writable).toBe(true);
  });
  it("makes exported student text safe for spreadsheet formulas", () => {
    const book = createNotebook(makeDefaultDesign());
    book.records.push({ id: "test", at: "2026-10-13T00:00:00Z", version: "A", design: book.versions[0]!.draft, prediction: '=HYPERLINK("evil")', observation: "+cmd", nextTest: "@test", result: { winner: "player1", seconds: 12, contacts: 3, angularSpeed: 10, modelVersion: "test" } });
    const csv = notebookCsv(book);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("'+cmd");
    expect(csv).toContain("'@test");
    expect(csv.startsWith("\uFEFF")).toBe(true);
  });
});
