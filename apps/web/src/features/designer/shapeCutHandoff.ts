/** Browser-only, one-shot handoff. Both GitHub Pages apps share an origin. */
export function startShapeCutHandoff(generate: () => Promise<ArrayBuffer>) {
  const token = crypto.randomUUID();
  const url = new URL('/ShapeCut/', window.location.origin);
  url.hash = new URLSearchParams({ 'bayblad-transfer': token }).toString();
  // Must precede any await to preserve the user's popup activation.
  const receiver = window.open(url.href, '_blank');
  let cancel = () => {};
  const done = new Promise<void>((resolve, reject) => {
    if (!receiver) { reject(new Error('請允許開啟新分頁，或使用「下載 STL」。')); return; }
    let finished = false;
    let ready = false;
    let sent = false;
    let bytes: ArrayBuffer | undefined;
    const envelope = { protocol: 'bayblad-shapecut', version: 1, token };
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      window.removeEventListener('message', receive);
      clearTimeout(timeout);
      clearInterval(closedCheck);
      bytes = undefined;
      if (error) reject(error); else resolve();
    };
    const send = () => {
      if (finished || sent || !ready || !bytes) return;
      try {
        receiver.postMessage({ ...envelope, type: 'stl', fileName: 'bayblad-3layers-6mm-mm.stl', bytes }, url.origin);
        sent = true;
        bytes = undefined;
      } catch { finish(new Error('未能傳送至 ShapeCut，請使用「下載 STL」後手動匯入。')); }
    };
    function receive(event: MessageEvent) {
      if (event.origin !== url.origin || event.source !== receiver) return;
      const data: unknown = event.data;
      if (!data || typeof data !== 'object') return;
      const message = data as Record<string, unknown>;
      if (message.protocol !== envelope.protocol || message.version !== 1 || message.token !== token) return;
      if (message.type === 'ready') { ready = true; send(); }
      if (message.type === 'accepted' && sent) finish();
      if (message.type === 'error') finish(new Error('ShapeCut 未能匯入，請使用「下載 STL」後手動匯入。'));
    }
    const timeout = window.setTimeout(() => finish(new Error('傳送逾時，請重試或使用「下載 STL」。')), 90_000);
    const closedCheck = window.setInterval(() => {
      if (receiver.closed) finish(new Error('ShapeCut 分頁已關閉，請重試或使用「下載 STL」。'));
    }, 500);
    cancel = () => finish(new Error('已停止等待。ShapeCut 可能已接收板材，請在該分頁確認。'));
    window.addEventListener('message', receive);
    // Attach rejection immediately, including synchronous generator errors.
    Promise.resolve().then(generate).then(result => {
      if (finished) return;
      if (result.byteLength < 84 || result.byteLength > 20 * 1024 * 1024) throw new Error('STL 大小超出傳送限制。');
      bytes = result;
      send();
    }).catch(() => finish(new Error('未能產生 STL，請檢查網絡後重試。')));
  });
  return { done, cancel: () => cancel() };
}
