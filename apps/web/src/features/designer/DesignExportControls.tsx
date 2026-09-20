import type { TopDesign } from '@steam-top/domain';
import { useRef, useState } from 'react';

export function DesignExportControls({ design, invalidFields }: Readonly<{ design: TopDesign; invalidFields: boolean }>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const exporting = useRef(false);
  async function download() {
    if (invalidFields || exporting.current) return;
    exporting.current = true;
    setBusy(true);
    setError(false);
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
      setError(true);
    } finally {
      exporting.current = false;
      setBusy(false);
    }
  }
  return <div className="design-export-controls" aria-label="板材匯出">
    <div className="room-controls">
      <button type="button" disabled={invalidFields || busy} onClick={() => void download()} aria-describedby="stl-export-note">
        {busy ? '正在產生 STL……' : '下載 STL（供 ShapeCut）'}
      </button>
      <a href="https://yuenhk.github.io/ShapeCut/" target="_blank" rel="noopener noreferrer">前往 ShapeCut 轉 DXF</a>
    </div>
    <p id="stl-export-note" className="field-note">只含三層板材，每層 6 mm，單位 mm；不含五金。ShapeCut 可能另加發射器孔位，切割前請核對及試切。</p>
    {invalidFields ? <p className="issue-message">請先修正數值欄位，再下載 STL。</p> : null}
    {busy ? <p role="status">正在準備三層板材檔案，請稍候。</p> : null}
    {error ? <p role="alert">未能產生 STL，請檢查網絡後再按下載重試。</p> : null}
  </div>;
}
