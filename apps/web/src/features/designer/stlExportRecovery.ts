import type { TopDesign } from '@steam-top/domain';
import { DESIGNER_DRAFT_KEY, DESIGNER_DRAFT_VERSION } from './designerDraft';

export class StlExportFailure extends Error {
  constructor(readonly needsReload: boolean) {
    super(needsReload
      ? '未能載入 STL 匯出工具。網站可能已更新，請保留設計並更新頁面，再重新傳送或下載。'
      : '未能產生 STL。請檢查層板形狀及孔位，再重試；這不一定是網絡問題。');
  }
}

export function stlExportFailure(reason: unknown): StlExportFailure {
  if (reason instanceof StlExportFailure) return reason;
  const message = reason instanceof Error ? reason.message : '';
  return new StlExportFailure(/dynamically imported|Importing a module|error loading.*module|Failed to fetch|Load failed|Loading chunk|ChunkLoadError/iu.test(message));
}

/** Never navigate unless this exact, applied design has been saved successfully. */
export function updatePageForStl(design: TopDesign, navigate: (url: string) => void = url => window.location.replace(url)): boolean {
  const payload = JSON.stringify({ version: DESIGNER_DRAFT_VERSION, design });
  try {
    localStorage.setItem(DESIGNER_DRAFT_KEY, payload);
    if (localStorage.getItem(DESIGNER_DRAFT_KEY) !== payload) return false;
  } catch { return false; }
  const fresh = new URL(window.location.href);
  fresh.searchParams.set('updated', String(Date.now()));
  navigate(fresh.href);
  return true;
}
