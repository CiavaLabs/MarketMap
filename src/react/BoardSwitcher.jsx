import { useEffect, useMemo, useState } from "react";
import { Button, Dialog, IconButton, Menu, Select, TextField } from "@ciavalabs/ds-react";
import { MAX_BOARD_NAME_LENGTH } from "../ui/models/boardLayout.js";

const manageIcon = (
  <svg aria-hidden="true" viewBox="0 0 24 24">
    <circle cx="5" cy="12" r="2"></circle>
    <circle cx="12" cy="12" r="2"></circle>
    <circle cx="19" cy="12" r="2"></circle>
  </svg>
);
const manageTrigger = <IconButton aria-label="Manage boards" variant="subtle" />;

export function BoardSwitcher({
  boards = [],
  activeBoardId,
  portalContainer,
  onSwitch,
  onCreate,
  onRename,
  onDuplicate,
  onDelete,
  onDialogOpenChange,
}) {
  const [dialogMode, setDialogMode] = useState(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const activeBoard = boards.find((board) => board.id === activeBoardId) || boards[0] || null;
  const options = useMemo(() => boards.map((board) => ({
    value: board.id,
    label: board.name,
  })), [boards]);

  useEffect(() => {
    onDialogOpenChange?.(dialogMode !== null);
  }, [dialogMode, onDialogOpenChange]);

  const openDialog = (mode) => {
    setDialogMode(mode);
    setName(mode === "rename" ? activeBoard?.name || "" : "");
    setError("");
  };
  const closeDialog = () => {
    setDialogMode(null);
    setName("");
    setError("");
  };
  const submit = (event) => {
    event.preventDefault();
    const requested = name.trim().replace(/\s+/g, " ");
    const mode = dialogMode;
    queueMicrotask(() => {
      const result = mode === "rename"
        ? onRename?.(activeBoardId, requested)
        : onCreate?.(requested);
      if (result?.ok === false) setError(result.message || "That board name is unavailable.");
      else closeDialog();
    });
  };

  if (!activeBoard) return null;
  const protectedBoard = activeBoard.isDefault === true;
  return (
    <div className="mm-board-switcher" aria-label="Board switcher">
      <Select
        aria-label="Board"
        className="mm-board-switcher__select"
        container={portalContainer}
        options={options}
        value={activeBoard.id}
        onValueChange={(boardId) => queueMicrotask(() => onSwitch?.(boardId))}
      />
      <Menu.Root modal={false}>
        <Menu.Trigger className="mm-board-switcher__manage" render={manageTrigger}>
          {manageIcon}
        </Menu.Trigger>
        <Menu.Portal container={portalContainer}>
          <Menu.Positioner className="mm-board-switcher__positioner" align="end">
            <Menu.Popup className="mm-board-switcher__menu">
              <Menu.Item onClick={() => openDialog("create")}>Create board</Menu.Item>
              <Menu.Item disabled={protectedBoard} onClick={() => openDialog("rename")}>
                Rename board
              </Menu.Item>
              <Menu.Item onClick={() => queueMicrotask(() => onDuplicate?.(activeBoard.id))}>
                Duplicate board
              </Menu.Item>
              <Menu.Separator />
              <Menu.Item
                className="mm-board-switcher__delete"
                disabled={protectedBoard || boards.length <= 1}
                onClick={() => queueMicrotask(() => onDelete?.(activeBoard.id))}
              >
                Delete board
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>

      <Dialog.Root open={dialogMode !== null} onOpenChange={(open) => {
        if (!open) closeDialog();
      }}>
        <Dialog.Content
          className="mm-board-dialog"
          container={portalContainer}
          style={{ width: "min(calc(100vw - 3rem), 30rem)" }}
        >
          <form onSubmit={submit}>
            <Dialog.Title>{dialogMode === "rename" ? "Rename board" : "Create board"}</Dialog.Title>
            <Dialog.Description>
              {dialogMode === "rename"
                ? "Choose a distinct name for this board."
                : "The new board starts empty and keeps its own layout and news state."}
            </Dialog.Description>
            <TextField
              autoFocus
              aria-label="Board name"
              maxLength={MAX_BOARD_NAME_LENGTH}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setError("");
              }}
            />
            {error ? <p className="mm-board-dialog__error" role="alert">{error}</p> : null}
            <footer>
              <Button type="button" variant="subtle" onClick={closeDialog}>Cancel</Button>
              <Button type="submit">{dialogMode === "rename" ? "Save name" : "Create board"}</Button>
            </footer>
          </form>
        </Dialog.Content>
      </Dialog.Root>
    </div>
  );
}
