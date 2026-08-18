import "@ciavalabs/ds-react/styles.scoped.css";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { ConsoleActions } from "./ConsoleActions.jsx";

export function mountConsoleActions(
  container,
  { onAddInstrument, onClearAll, onRestoreDefaults, onToggleTheme, showTheme } = {},
) {
  const root = createRoot(container);
  flushSync(() => {
    root.render(
      <ConsoleActions
        onAddInstrument={onAddInstrument}
        onClearAll={onClearAll}
        onRestoreDefaults={onRestoreDefaults}
        onToggleTheme={onToggleTheme}
        showTheme={showTheme}
      />,
    );
  });
  return root;
}
