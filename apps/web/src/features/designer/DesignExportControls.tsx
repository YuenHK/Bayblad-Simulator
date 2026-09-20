import type { TopDesign } from '@steam-top/domain';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { startShapeCutHandoff } from './shapeCutHandoff';

export function DesignExportControls({ design, invalidFields, children }: Readonly<{ design: TopDesign; invalidFields: boolean; children?: ReactNode }>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const exporting = useRef(false);
  const cancelTransfer = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => cancelTransfer.current?.(), []);
  async function transfer() {
    if (invalidFields || exporting.current) return;
    exporting.current = true;
    setBusy(true);
    setError('');
    setStatus('正在傳送三層板材，請在新分頁繼續。');
    try {
      const snapshot = structuredClone(design);
      const handoff = startShapeCutHandoff(async () => {
        const { exportBoardsStl } = await import('./loadBoardsStl');
        return exportBoardsStl(snapshot);
      });
      cancelTransfer.current = handoff.cancel;
      await handoff.done;
      setStatus('ShapeCut 已接收板材。請在新分頁選擇材料，再開始製作。');
    } catch (cause) {
      setStatus('');
      setError(cause instanceof Error ? cause.message : '傳送失敗，請使用「下載 STL」。');
    } finally {
      cancelTransfer.current = undefined;
      exporting.current = false;
      setBusy(false);
    }
  }
  async function download() {
    if (invalidFields || exporting.current) return;
    exporting.current = true;
    setBusy(true);
    setError('');
    setStatus('正在準備三層板材檔案，請稍候。');
    try {
      // Capture the design at click time; do not mix later edits into this export.
      const snapshot = structuredClone(design);
      const { exportBoardsStl } = await import('./loadBoardsStl');
      const data = await exportBoardsStl(snapshot);
      const url = URL.createObjectURL(new Blob([data], { type: 'model/stl' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'bayblad-3layers-6mm-mm.stl';
      document.body.append(anchor);
      try { anchor.click(); } finally {
        anchor.remove();
        // Safari needs time to consume the Blob after the click.
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    } catch {
      setError('未能產生 STL，請檢查網絡後再按下載重試。');
    } finally {
      exporting.current = false;
      setBusy(false);
      setStatus('');
    }
  }
  return <div className="design-export-controls" aria-label="板材匯出">
    <div className="design-action-row">
      {children}
      <button type="button" disabled={invalidFields || busy} onClick={() => void transfer()} aria-describedby="stl-export-note">傳送至 ShapeCut（供 雷射切割)</button>
      <button type="button" disabled={invalidFields || busy} onClick={() => void download()} aria-describedby="stl-export-note">
        下載 STL（供 3D打印)
      </button>
      {busy && cancelTransfer.current ? <button type="button" onClick={() => cancelTransfer.current?.()}>停止等待</button> : null}
    </div>
    <p id="stl-export-note" className="field-note">只含三層板材，每層 6 mm，單位 mm；不含五金。ShapeCut 可能另加發射器孔位，切割前請核對及試切。</p>
    {invalidFields ? <p className="issue-message">請先修正數值欄位，再下載 STL。</p> : null}
    {status ? <p role="status">{status}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}
