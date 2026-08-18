import "@ciavalabs/ds-react/styles.scoped.css";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Toast } from "@ciavalabs/ds-react";
import { ToastHost } from "./ToastHost.jsx";

export function mountToastHost(container) {
  const toastManager = Toast.createToastManager();
  const root = createRoot(container);
  flushSync(() => {
    root.render(<ToastHost toastManager={toastManager} portalContainer={container} />);
  });
  return {
    root,
    notify(message, duration, action) {
      let toastId;
      const actionProps = action?.label && typeof action.onClick === "function"
        ? {
            children: action.label,
            onClick: (event) => {
              action.onClick(event);
              toastManager.close(toastId);
            },
          }
        : undefined;
      toastId = toastManager.add({
        description: message,
        timeout: duration,
        ...(actionProps ? { actionProps } : {}),
      });
      return toastId;
    },
  };
}
