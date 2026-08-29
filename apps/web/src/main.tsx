import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("找不到應用程式根節點");
}

const AdminApp = lazy(() => import("./features/admin/AdminApp").then(module => ({ default: module.AdminApp })));
createRoot(root).render(
  <StrictMode>
    {window.location.pathname.startsWith("/admin") ? <Suspense fallback={<p role="status">正在載入教師後台……</p>}><AdminApp /></Suspense> : <App />}
  </StrictMode>,
);
