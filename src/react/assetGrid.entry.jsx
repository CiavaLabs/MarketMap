import "@ciavalabs/ds-react/styles.scoped.css";
import { createRef } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { AssetGrid } from "./AssetGrid.jsx";

export function mountAssetGrid(container, {
  onSelectTile,
  onNewsRetry,
  onReorder,
  onNewsOpenChange,
  initialLayout,
} = {}) {
  const apiRef = createRef();
  const root = createRoot(container);
  flushSync(() => {
    root.render(
      <AssetGrid
        ref={apiRef}
        containerElement={container}
        initialLayout={initialLayout}
        onNewsOpenChange={onNewsOpenChange}
        onSelectTile={onSelectTile}
        onNewsRetry={onNewsRetry}
        onReorder={onReorder}
      />,
    );
  });
  return { root, ...apiRef.current };
}
