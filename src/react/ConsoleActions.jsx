import { Button, IconButton } from "@ciavalabs/ds-react";

const sunIcon = (
  <svg className="mm-icon-sun" aria-hidden="true" viewBox="0 0 24 24">
    <circle cx="12" cy="12" r="4.4"></circle>
    <path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7"></path>
  </svg>
);

const moonIcon = (
  <svg className="mm-icon-moon" aria-hidden="true" viewBox="0 0 24 24">
    <path d="M20.2 14.2A8.2 8.2 0 0 1 9.8 3.8a8.2 8.2 0 1 0 10.4 10.4Z"></path>
  </svg>
);

const plusIcon = (
  <svg aria-hidden="true" viewBox="0 0 24 24">
    <path d="M12 5v14M5 12h14"></path>
  </svg>
);

export function ConsoleActions({
  onAddInstrument,
  onClearAll,
  onRestoreDefaults,
  onToggleTheme,
  showTheme = true,
}) {
  return (
    <>
      {showTheme && (
        <IconButton id="theme-btn" aria-label="Switch color theme" onClick={onToggleTheme}>
          {sunIcon}
          {moonIcon}
        </IconButton>
      )}
      <Button id="btn-clear-all" variant="danger" size="sm" onClick={onClearAll}>
        Clear board
      </Button>
      <Button id="btn-restore-defaults" variant="subtle" size="sm" onClick={onRestoreDefaults}>
        Restore defaults
      </Button>
      <Button className="mm-actions__add" id="add-instrument-btn" variant="primary" size="sm" onClick={onAddInstrument}>
        {plusIcon}
        Add instrument
      </Button>
    </>
  );
}
