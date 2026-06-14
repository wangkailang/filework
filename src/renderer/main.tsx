import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./global.css";
import "./styles/hljs-theme.css";
import { startThemeSync } from "./lib/theme";

const root = document.getElementById("root");
if (root) {
  startThemeSync();
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
