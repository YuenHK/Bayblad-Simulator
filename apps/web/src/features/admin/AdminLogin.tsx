import { useState } from "react";
import { jsonHeaders, requestJson } from "./api";
import type { Fetcher } from "./types";
export function AdminLogin({ fetcher, onSuccess }: { fetcher: Fetcher; onSuccess: () => Promise<void> }) {
  const [username, setUsername] = useState("admin"), [password, setPassword] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <main className="admin-login"><form className="panel admin-login-card" onSubmit={async event => { event.preventDefault(); setBusy(true); setError(""); try { await requestJson(fetcher, "/api/admin/login", { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ username, password }) }); setPassword(""); await onSuccess(); } catch { setError("帳號或密碼不正確，請稍後再試。"); } finally { setBusy(false); } }} autoComplete="on">
    <p className="eyebrow">教師專用</p><h1>教師登入</h1><p>登入後可管理房間、查看紀錄及統計。</p>
    <label>帳號<input name="username" autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} required /></label>
    <label>密碼<input name="password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required /></label>
    {error ? <p role="alert" className="field-error">{error}</p> : null}<button className="primary-button" disabled={busy}>{busy ? "登入中……" : "登入"}</button>
  </form></main>;
}
