import { afterEach, expect, it, vi } from 'vitest';
import { startShapeCutHandoff } from './shapeCutHandoff';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
function setup() {
  const popup = { postMessage: vi.fn(), closed: false };
  vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
  const data = new ArrayBuffer(134);
  const transfer = startShapeCutHandoff(async () => data);
  const url = new URL(vi.mocked(window.open).mock.calls[0]![0] as string);
  const token = new URLSearchParams(url.hash.slice(1)).get('bayblad-transfer');
  const message = (type: string, extra = {}, origin = location.origin, source = popup) => window.dispatchEvent(new MessageEvent('message', {
    origin, source: source as unknown as Window, data: { protocol: 'bayblad-shapecut', version: 1, token, type, ...extra },
  }));
  return { popup, transfer, message, data };
}
it('opens synchronously, sends only to the bound receiver and waits for acceptance', async () => {
  const { popup, transfer, message, data } = setup();
  message('ready', {}, 'https://wrong.example');
  message('ready', { token: 'wrong' });
  message('ready', {}, location.origin, { postMessage: vi.fn(), closed: false });
  await Promise.resolve();
  expect(popup.postMessage).not.toHaveBeenCalled();
  message('accepted');
  message('ready');
  await vi.waitFor(() => expect(popup.postMessage).toHaveBeenCalledTimes(1));
  expect(popup.postMessage.mock.calls[0]![0]).toMatchObject({ type: 'stl', bytes: data });
  expect(popup.postMessage.mock.calls[0]![1]).toBe(location.origin);
  message('ready');
  expect(popup.postMessage).toHaveBeenCalledTimes(1);
  message('accepted');
  await expect(transfer.done).resolves.toBeUndefined();
});
it('reports blocked popups without generating data', async () => {
  vi.spyOn(window, 'open').mockReturnValue(null);
  const generate = vi.fn();
  const transfer = startShapeCutHandoff(generate);
  await expect(transfer.done).rejects.toThrow('新分頁');
  expect(generate).not.toHaveBeenCalled();
});
it('expires and stops listening', async () => {
  vi.useFakeTimers();
  const { transfer, message, popup } = setup();
  const failed = expect(transfer.done).rejects.toThrow('逾時');
  await vi.advanceTimersByTimeAsync(90_000);
  await failed;
  message('ready');
  expect(popup.postMessage).not.toHaveBeenCalled();
});
it('can stop waiting without claiming to retract an already delivered model', async () => {
  const { transfer, message, popup } = setup();
  const failed = expect(transfer.done).rejects.toThrow('ShapeCut 可能已接收板材');
  transfer.cancel();
  await failed;
  message('ready');
  expect(popup.postMessage).not.toHaveBeenCalled();
});
it('reports receiver failure instead of claiming success', async () => {
  const { transfer, message } = setup();
  message('error');
  await expect(transfer.done).rejects.toThrow('ShapeCut');
});
it('stops waiting after delivery and warns that the receiver may still import', async () => {
  const { transfer, message, popup } = setup();
  message('ready');
  await vi.waitFor(() => expect(popup.postMessage).toHaveBeenCalledTimes(1));
  const failed = expect(transfer.done).rejects.toThrow('ShapeCut 可能已接收板材');
  transfer.cancel();
  message('accepted');
  await failed;
});
it('detects a closed receiver', async () => {
  vi.useFakeTimers();
  const { transfer, popup } = setup();
  const failed = expect(transfer.done).rejects.toThrow('分頁已關閉');
  popup.closed = true;
  await vi.advanceTimersByTimeAsync(500);
  await failed;
});
