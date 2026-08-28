import {
  designSchema,
  makeDefaultDesign,
  type TopDesign,
} from "@steam-top/domain";

export const DESIGNER_DRAFT_VERSION = 1 as const;
export const DESIGNER_DRAFT_KEY = "steam-top:designer-draft:v1";

export function loadDesignerDraft(): TopDesign {
  try {
    const raw = localStorage.getItem(DESIGNER_DRAFT_KEY);
    if (raw === null) return makeDefaultDesign();
    const payload: unknown = JSON.parse(raw);
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("version" in payload) ||
      payload.version !== DESIGNER_DRAFT_VERSION ||
      !("design" in payload)
    ) {
      return makeDefaultDesign();
    }
    const parsed = designSchema.safeParse(payload.design);
    return parsed.success ? parsed.data : makeDefaultDesign();
  } catch {
    return makeDefaultDesign();
  }
}

export function saveDesignerDraft(design: TopDesign): void {
  const parsed = designSchema.safeParse(design);
  if (!parsed.success) return;
  try {
    localStorage.setItem(DESIGNER_DRAFT_KEY, JSON.stringify({
      version: DESIGNER_DRAFT_VERSION,
      design: parsed.data,
    }));
  } catch {
    // Storage can be disabled or full; the in-memory designer remains usable.
  }
}
