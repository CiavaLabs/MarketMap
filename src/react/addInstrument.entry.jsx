import "@ciavalabs/ds-react/styles.scoped.css";
import { createRef } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { AddInstrumentDialog } from "./AddInstrumentDialog.jsx";

export function mountAddInstrument(container, { assetClassOptions, onQueryChange, onFilterChange, onAdd, onClose } = {}) {
  const apiRef = createRef();
  const root = createRoot(container);
  const appRoot = container.closest(".marketmap-app") || container.parentElement;
  const portalContainer = appRoot?.querySelector("#mm-overlay-root") || appRoot || null;
  flushSync(() => {
    root.render(
      <AddInstrumentDialog
        ref={apiRef}
        assetClassOptions={assetClassOptions}
        onQueryChange={onQueryChange}
        onFilterChange={onFilterChange}
        onAdd={onAdd}
        onClose={onClose}
        portalContainer={portalContainer}
      />,
    );
  });
  return { root, ...apiRef.current };
}
