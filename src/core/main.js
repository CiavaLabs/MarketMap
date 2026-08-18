import { createMarketMapExperience } from "../app/createMarketMapExperience.js";
import { perfMonitor, perfReport } from "../utils/PerfMonitor.js";

async function loadReactIslands() {
  try {
    const [
      { mountConsoleActions },
      { mountToolbar },
      { mountAddInstrument },
      { mountInstrumentDetail },
      { mountToastHost },
      { mountAssetGrid },
    ] = await Promise.all([
      import("../../assets/react/console-actions.js"),
      import("../../assets/react/toolbar.js"),
      import("../../assets/react/add-instrument.js"),
      import("../../assets/react/instrument-detail.js"),
      import("../../assets/react/toast-host.js"),
      import("../../assets/react/asset-grid.js"),
    ]);
    return { mountConsoleActions, mountToolbar, mountAddInstrument, mountInstrumentDetail, mountToastHost, mountAssetGrid };
  } catch (error) {
    console.warn("MarketMap: React islands unavailable — run `npm run build:react-demo`.", error);
    return undefined;
  }
}
const reactIslands = await loadReactIslands();

let experience = null;

window.__marketmapPerfEnabled ??= true;
window.__marketmapPerf ??= perfMonitor;
window.showMarketMapPerf ??= (options = {}) => perfReport({
  toConsole: true,
  sortBy: "score",
  ...options,
});

function applyDocumentTheme(theme) {
  document.body.dataset.theme = theme;
  document.documentElement.dataset.theme = theme;
}

export function initMarketMap() {
  if (experience) return experience;

  const root = document.querySelector("[data-marketmap-root]");
  if (!root) return null;

  experience = createMarketMapExperience({
    root,
    persistTheme: true,
    reactIslands,
    onThemeRequest: applyDocumentTheme,
    setScrollLocked(locked) {
      document.documentElement.style.overflow = locked ? "hidden" : "";
    },
  });
  applyDocumentTheme(root.dataset.marketmapTheme);
  return experience;
}

export function destroyMarketMap() {
  experience?.destroy();
  experience = null;
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initMarketMap, { once: true });
} else {
  initMarketMap();
}

window.MarketMapStandalone = Object.freeze({
  start: initMarketMap,
  destroy: destroyMarketMap,
  pause: () => experience?.pause(),
  resume: () => experience?.resume(),
  getInstance: () => experience?.app,
});
