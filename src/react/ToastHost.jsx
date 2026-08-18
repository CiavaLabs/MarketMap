import { Toast } from "@ciavalabs/ds-react";

function ToastList() {
  const { toasts } = Toast.useToastManager();
  return toasts.map((toast) => (
    <Toast.Root key={toast.id} toast={toast}>
      <Toast.Title />
      <Toast.Description />
      {toast.actionProps ? <Toast.Action /> : null}
      <Toast.Close />
    </Toast.Root>
  ));
}

export function ToastHost({ toastManager, portalContainer }) {
  return (
    <Toast.Provider toastManager={toastManager}>
      <Toast.Portal container={portalContainer}>
        <Toast.Viewport>
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}
