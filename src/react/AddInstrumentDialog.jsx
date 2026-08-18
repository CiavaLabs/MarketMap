import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Dialog, Select, TextField, SearchResultItem } from "@ciavalabs/ds-react";

const SearchIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <path d="m16.5 16.5 4 4" />
  </svg>
);

const VENUE_OPTIONS = [
  { value: "all", label: "All venues" },
  { value: "XNAS", label: "Nasdaq" },
  { value: "XNYS", label: "NYSE" },
  { value: "ARCX", label: "NYSE Arca" },
  { value: "XLON", label: "London" },
];

const CURRENCY_OPTIONS = [
  { value: "all", label: "All currencies" },
  { value: "USD", label: "USD" },
  { value: "EUR", label: "EUR" },
  { value: "GBP", label: "GBP" },
  { value: "CAD", label: "CAD" },
  { value: "JPY", label: "JPY" },
];

const DEFAULT_FILTERS = { assetClass: "all", venue: "all", currency: "all" };
const DEFAULT_CONTENT = { rows: [], heading: null, message: "" };

const HEADING_STYLE = { display: "grid", gap: 6, marginBottom: 24, textAlign: "center" };
const SEARCH_STYLE = { display: "grid", marginBottom: 12 };
const FILTERS_STYLE = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 8rem), 1fr))",
  gap: 8,
  marginBottom: 20,
};

const ADD_LABEL = { add: "Add", added: "Added", unavailable: "Unavailable", validating: "Validating…", retry: "Retry" };
const DISABLED_STATES = new Set(["unavailable", "validating"]);

export const AddInstrumentDialog = forwardRef(function AddInstrumentDialog(
  { assetClassOptions, onQueryChange, onFilterChange, onAdd, onClose, portalContainer },
  ref,
) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [content, setContent] = useState(DEFAULT_CONTENT);
  const [count, setCount] = useState("");
  const [dialogPortal, setDialogPortal] = useState(null);
  const filtersRef = useRef(filters);
  const returnFocusRef = useRef(null);
  const portalContainerRef = useRef(portalContainer);
  filtersRef.current = filters;
  portalContainerRef.current = portalContainer;

  useImperativeHandle(ref, () => ({
    setOpen: (next) => flushSync(() => {
      if (next) {
        const owner = portalContainerRef.current?.ownerDocument || globalThis.document;
        const active = owner?.activeElement;
        returnFocusRef.current = active && active !== owner.body ? active : null;
      }
      setOpen(next);
      if (next) setQuery("");
    }),
    setContent: (next) => flushSync(() => setContent({ ...DEFAULT_CONTENT, ...next })),
    setCount: (text) => flushSync(() => setCount(text)),
    setFilters: (next) => flushSync(() => setFilters((current) => ({ ...current, ...next }))),
    getFilters: () => filtersRef.current,
  }), []);

  const emitFilter = (patch) => {
    const next = { ...filtersRef.current, ...patch };
    filtersRef.current = next;
    setFilters(next);
    onFilterChange?.(next);
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(next) => { if (!next) onClose?.(); }}
    >
      <Dialog.Content
        id="add-instrument-dialog"
        portalRef={setDialogPortal}
        container={portalContainer}
        finalFocus={() => returnFocusRef.current?.isConnected ? returnFocusRef.current : null}
        style={{ width: "min(calc(100vw - 3rem), 35rem)" }}
      >
        <div className="mm-add-dialog">
          <div className="mm-add-dialog__heading" style={HEADING_STYLE}>
            <Dialog.Title>Add instrument</Dialog.Title>
            <Dialog.Description>
              Search by name, ticker, pair, index or fund
              {count ? <> · <span id="add-ticker-count">{count}</span></> : null}
            </Dialog.Description>
          </div>

          <div style={SEARCH_STYLE}>
            <TextField
              id="add-ticker-input"
              type="search"
              icon={<SearchIcon />}
              placeholder="Name, ticker, pair, index or fund"
              autoComplete="off"
              autoFocus
              aria-label="Name, ticker, pair, index or fund"
              containerClassName="mm-add-dialog__search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                onQueryChange?.(event.target.value);
              }}
            />
          </div>

          <div className="mm-add-dialog__filters" style={FILTERS_STYLE}>
            <Select
              aria-label="Asset class"
              container={dialogPortal || portalContainer}
              options={assetClassOptions}
              value={filters.assetClass}
              onValueChange={(value) => emitFilter({ assetClass: value })}
            />
            <Select
              aria-label="Venue"
              container={dialogPortal || portalContainer}
              options={VENUE_OPTIONS}
              value={filters.venue}
              onValueChange={(value) => emitFilter({ venue: value })}
            />
            <Select
              aria-label="Currency"
              container={dialogPortal || portalContainer}
              options={CURRENCY_OPTIONS}
              value={filters.currency}
              onValueChange={(value) => emitFilter({ currency: value })}
            />
          </div>

          <div className="mm-add-dialog__results" aria-live="polite">
            {content.heading ? <p className="mm-add-dialog__results-heading">{content.heading}</p> : null}
            {content.rows.length
              ? content.rows.map((row) => (
                <SearchResultItem
                  key={row.id}
                  className="mm-search-result"
                  data-instrument-id={row.id}
                  avatarLabel={row.monogram}
                  avatarTone={row.tone}
                  title={row.title}
                  subtitle={row.subtitle}
                  onBoard={row.state === "added"}
                  onBoardLabel="Added"
                  addLabel={ADD_LABEL[row.state] || "Add"}
                  disabled={DISABLED_STATES.has(row.state)}
                  onAdd={() => onAdd?.(row.id)}
                />
              ))
              : content.message
                ? <p className="mm-add-dialog__message">{content.message}</p>
                : null}
          </div>
        </div>
      </Dialog.Content>
    </Dialog.Root>
  );
});
