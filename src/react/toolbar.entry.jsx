import "@ciavalabs/ds-react/styles.scoped.css";
import { createRef } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Toolbar } from "./Toolbar.jsx";

export function mountToolbar(container, {
  initialState,
  assetClassOptions,
  categoryOptions,
  boardState,
  onChange,
  onBoardSwitch,
  onBoardCreate,
  onBoardRename,
  onBoardDuplicate,
  onBoardDelete,
  onBoardDialogOpenChange,
} = {}) {
  const apiRef = createRef();
  const root = createRoot(container);
  const appRoot = container.closest(".marketmap-app");
  const portalContainer = appRoot?.querySelector("#mm-overlay-root") || appRoot || null;
  flushSync(() => {
    root.render(
      <Toolbar
        ref={apiRef}
        initialState={initialState}
        assetClassOptions={assetClassOptions}
        categoryOptions={categoryOptions}
        boardState={boardState}
        onChange={onChange}
        onBoardSwitch={onBoardSwitch}
        onBoardCreate={onBoardCreate}
        onBoardRename={onBoardRename}
        onBoardDuplicate={onBoardDuplicate}
        onBoardDelete={onBoardDelete}
        onBoardDialogOpenChange={onBoardDialogOpenChange}
        portalContainer={portalContainer}
      />,
    );
  });
  return { root, ...apiRef.current };
}
