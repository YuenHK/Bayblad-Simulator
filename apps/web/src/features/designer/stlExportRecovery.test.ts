import { afterEach, expect, it, vi } from 'vitest';
import { makeDefaultDesign } from '@steam-top/domain';
import { loadDesignerDraft } from './designerDraft';
import { stlExportFailure, updatePageForStl } from './stlExportRecovery';

afterEach(() => vi.restoreAllMocks());
it('saves the exact design before navigating to a cache-busted page', () => {
  const design = makeDefaultDesign();
  const navigate = vi.fn((_url: string) => expect(loadDesignerDraft()).toEqual(design));
  expect(updatePageForStl(design, navigate)).toBe(true);
  expect(new URL(navigate.mock.calls[0]![0] as string).searchParams.has('updated')).toBe(true);
});
it('does not refresh or erase a design when storage is unavailable', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  const navigate = vi.fn();
  expect(updatePageForStl(makeDefaultDesign(), navigate)).toBe(false);
  expect(navigate).not.toHaveBeenCalled();
});
it('does not disguise geometry errors as outdated modules or expose raw diagnostics', () => {
  const error = stlExportFailure(new Error('Degenerate STL face'));
  expect(error.needsReload).toBe(false);
  expect(error.message).toContain('形狀及孔位');
  expect(error.message).not.toContain('Degenerate');
});
