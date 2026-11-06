import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import { CrashScreen } from "./ui/CrashScreen";
import { loadSettings } from "./ui/ask/settings";
import "./ui/styles.css";

// The app has its own right-click menus everywhere, so the browser's menu is
// turned off across the page. It still opens in text fields (for copy and
// paste), and Shift+right-click opens it anywhere as an escape hatch.
document.addEventListener("contextmenu", (e) => {
  if (e.shiftKey) return;
  const t = e.target as HTMLElement | null;
  if (t?.closest?.("input, textarea, [contenteditable='true']")) return;
  e.preventDefault();
});

// A link from the one-click launcher (#bridge=…&token=…) pairs the AI with the
// local bridge before anything else reads the settings.
loadSettings();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CrashScreen>
      <App />
    </CrashScreen>
  </StrictMode>,
);
