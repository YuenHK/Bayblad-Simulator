import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeDefaultDesign } from '@steam-top/domain';
import { afterEach, expect, it, vi } from 'vitest';
import { DesignExportControls } from './DesignExportControls';
import { DesignerPage } from './DesignerPage';

vi.mock('./loadBoardsStl', () => ({ exportBoardsStl: vi.fn() }));
import { exportBoardsStl } from './loadBoardsStl';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('disables download for invalid visible fields in the designer', async () => {
  render(<DesignerPage />);
  const user = userEvent.setup();
  expect(screen.getByRole('button', { name: '下載 STL（供 3D打印)' })).toBeEnabled();
  await user.clear(screen.getByLabelText('直徑（mm）'));
  expect(screen.getByRole('button', { name: '下載 STL（供 3D打印)' })).toBeDisabled();
});

it('shows an actionable failure and allows a second attempt to download', async () => {
  vi.mocked(exportBoardsStl).mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(new ArrayBuffer(84));
  const createObjectURL = vi.fn(() => 'blob:test');
  class DownloadURL extends URL {
    static override createObjectURL = createObjectURL;
    static override revokeObjectURL = vi.fn();
  }
  vi.stubGlobal('URL', DownloadURL);
  const clicked: HTMLAnchorElement[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function(this: HTMLAnchorElement) { clicked.push(this); });
  render(<DesignExportControls design={makeDefaultDesign()} invalidFields={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '下載 STL（供 3D打印)' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('未能產生 STL');
  await user.click(screen.getByRole('button', { name: '下載 STL（供 3D打印)' }));
  await waitFor(() => expect(clicked).toHaveLength(1));
  expect(clicked[0]!.download).toBe('bayblad-3layers-6mm-mm.stl');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '傳送至 ShapeCut（供 雷射切割)' })).toBeEnabled();
});

it('offers a download fallback when the transfer popup is blocked', async () => {
  vi.spyOn(window, 'open').mockReturnValue(null);
  render(<DesignExportControls design={makeDefaultDesign()} invalidFields={false} />);
  await userEvent.setup().click(screen.getByRole('button', { name: '傳送至 ShapeCut（供 雷射切割)' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('新分頁');
  expect(screen.getByRole('button', { name: '下載 STL（供 3D打印)' })).toBeEnabled();
});
