import { useState } from "react";
import { jsonHeaders, requestJson } from "./api";
import type { Fetcher } from "./types";
export function AdminLogin({ fetcher, onSuccess }: { fetcher: Fetcher; onSuccess: () => Promise<void> }) {
  const [password, setPassword] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <main className="admin-login"><form className="panel admin-login-card" onSubmit={async event => { event.preventDefault(); setBusy(true); setError(""); try { await requestJson(fetcher, "/api/admin/login", { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ passphrase: password }) }); setPassword(""); await onSuccess(); } catch { setError("口令不正確或暫時未能連線，請稍後再試。"); } finally { setBusy(false); } }} autoComplete="on">
    <p className="eyebrow">共用入口</p><h1>教師控制台</h1><p>輸入口令可查看紀錄、學生資料及統計。此入口不是私人教師帳戶，請勿把資料轉發到公開地方。</p>
    <label>口令<input name="passphrase" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required /></label>
    {error ? <p role="alert" className="field-error">{error}</p> : null}<button className="primary-button" disabled={busy}>{busy ? "登入中……" : "進入控制台"}</button>
  </form></main>;
}
