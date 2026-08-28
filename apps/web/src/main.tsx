import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { DesignerPage } from "./features/designer/DesignerPage";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("找不到應用程式根節點");
}

createRoot(root).render(
  <StrictMode>
    <DesignerPage />
  </StrictMode>,
);
