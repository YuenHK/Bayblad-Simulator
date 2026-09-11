import { useState } from "react";
import { AdminModal } from "./AdminModal";
import { AdminApiError, jsonHeaders, requestJson } from "./api";
import type { AdminSession, Fetcher } from "./types";

export function ChangePasswordDialog({ fetcher, session, onClose, onChanged }: {
  fetcher: Fetcher; session: AdminSession; onClose: () => void; onChanged: () => void;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <AdminModal title="更改管理員密碼" onClose={() => { if (!busy) onClose(); }}>
    <p>請使用至少 12 個字元的全新密碼。儲存後，所有裝置的教師登入會失效，需重新登入。</p>
    <form onSubmit={async (event) => {
      event.preventDefault();
      if (busy) return;
      if (newPassword !== confirmation) { setError("兩次輸入的新密碼不一致。"); return; }
      if (newPassword === currentPassword) { setError("新密碼不可與目前密碼相同。"); return; }
      setBusy(true); setError("");
      try {
        await requestJson(fetcher, "/api/admin/password", { method: "POST", headers: jsonHeaders(session.csrfToken), body: JSON.stringify({ currentPassword, newPassword }) });
        setCurrentPassword(""); setNewPassword(""); setConfirmation(""); onChanged();
      } catch (failure) {
        setCurrentPassword("");
        if (failure instanceof AdminApiError && failure.status === 401) onChanged();
        else setError(failure instanceof AdminApiError && failure.status === 403 ? "目前密碼不正確、登入已失效或嘗試過多，請稍後重試。" : "未能確認密碼已更新。請嘗試重新登入，再檢查結果。");
      } finally { setBusy(false); }
    }}>
      <label>目前密碼<input type="password" autoComplete="current-password" required minLength={8} maxLength={1024} value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} disabled={busy} /></label>
      <label>新密碼<input type="password" autoComplete="new-password" required minLength={12} maxLength={1024} value={newPassword} onChange={event => setNewPassword(event.target.value)} disabled={busy} /></label>
      <label>確認新密碼<input type="password" autoComplete="new-password" required minLength={12} maxLength={1024} value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={busy} /></label>
      {error ? <p role="alert">{error}</p> : null}
      <div className="dialog-actions">
        <button type="button" disabled={busy} onClick={onClose}>取消</button>
        <button type="submit" disabled={busy}>{busy ? "正在更新……" : "儲存新密碼並登出"}</button>
      </div>
    </form>
  </AdminModal>;
}
