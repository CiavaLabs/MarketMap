import { createRef } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { InstrumentDetail } from "./InstrumentDetail.jsx";
import "@ciavalabs/ds-react/styles.scoped.css";

export function mountInstrumentDetail(container, callbacks = {}) {
  if (!container) return null;
  const apiRef = createRef();
  const root = createRoot(container);
  const appRoot = container.closest(".marketmap-app") || container.parentElement;
  const portalContainer = appRoot?.querySelector("#mm-overlay-root") || appRoot || null;
  flushSync(() => {
    root.render(<InstrumentDetail ref={apiRef} portalContainer={portalContainer} {...callbacks} />);
  });
  return { root, ...apiRef.current };
}
