import { renderMarketMapShell } from "../app/marketMapShell.js";
import { CONFIG } from "../config.js";
import { systemTheme } from "../utils/systemTheme.js";

function storedTheme() {
  try {
    const saved = localStorage.getItem(CONFIG.STORAGE.THEME);
    return saved === "light" || saved === "dark" ? saved : null;
  } catch {
    return null;
  }
}

const root = document.querySelector("[data-marketmap-root]");
if (root) {
  const theme = storedTheme() || systemTheme();
  root.dataset.marketmapTheme = theme;
  root.dataset.theme = theme;
  document.documentElement.dataset.theme = theme;
  renderMarketMapShell(root);
}
await import("./main.js");
