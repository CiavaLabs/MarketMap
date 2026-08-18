import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Select, TextField } from "@ciavalabs/ds-react";
import { BoardSwitcher } from "./BoardSwitcher.jsx";

const searchIcon = (
  <svg aria-hidden="true" viewBox="0 0 24 24">
    <circle cx="11" cy="11" r="7"></circle>
    <path d="m16.5 16.5 4 4"></path>
  </svg>
);

const MOVEMENT_OPTIONS = [
  { value: "all", label: "All" },
  { value: "advancing", label: "Advancing" },
  { value: "declining", label: "Declining" },
  { value: "gaining", label: "Gainers" },
  { value: "losing", label: "Losers" },
  { value: "neutral", label: "Near flat" },
  { value: "available", label: "Available data" },
  { value: "delayed", label: "Delayed data" },
  { value: "stale", label: "Last confirmed" },
  { value: "unavailable", label: "Unavailable" },
];

const SORT_OPTIONS = [
  { value: "default", label: "Curated order" },
  { value: "change-desc", label: "Best performers" },
  { value: "change-asc", label: "Worst performers" },
  { value: "price-desc", label: "Highest price" },
  { value: "price-asc", label: "Lowest price" },
  { value: "ticker", label: "Ticker A–Z" },
  { value: "quality", label: "Data quality" },
];

const DEFAULT_STATE = { search: "", assetClass: "all", category: "all", movement: "all", sort: "default" };
const ALL_ONLY = [{ value: "all", label: "All" }];

function labelFor(options, value) {
  return options.find((option) => option.value === value)?.label || value;
}

function ToolbarField({ label, modifier, children }) {
  return (
    <div className={`mm-toolbar__field${modifier ? ` mm-toolbar__field--${modifier}` : ""}`}>
      <span className="mm-toolbar__label" aria-hidden="true">{label}</span>
      {children}
    </div>
  );
}

export const Toolbar = forwardRef(function Toolbar(
  {
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
    portalContainer,
  },
  ref,
) {
  const [state, setState] = useState(() => ({ ...DEFAULT_STATE, ...initialState }));
  const [assetClasses, setAssetClasses] = useState(assetClassOptions?.length ? assetClassOptions : ALL_ONLY);
  const [categories, setCategories] = useState(categoryOptions?.length ? categoryOptions : ALL_ONLY);
  const [boards, setBoards] = useState(() => ({
    boards: boardState?.boards || [],
    activeBoardId: boardState?.activeBoardId || null,
  }));
  const stateRef = useRef(state);
  stateRef.current = state;

  useImperativeHandle(ref, () => ({
    setOptions: ({ assetClass, category } = {}) => flushSync(() => {
      if (assetClass) setAssetClasses(assetClass.length ? assetClass : ALL_ONLY);
      if (category) setCategories(category.length ? category : ALL_ONLY);
    }),
    setValues: (next) => flushSync(() => setState((current) => ({ ...current, ...next }))),
    setBoards: (next) => flushSync(() => setBoards((current) => ({ ...current, ...next }))),
    getState: () => stateRef.current,
  }), []);

  const emit = (patch, source) => {
    const next = { ...stateRef.current, ...patch };
    stateRef.current = next;
    setState(next);
    onChange?.(next, source);
  };
  const activeCriteria = [
    state.search.trim() ? {
      key: "search",
      label: `Search: “${state.search.trim()}”`,
    } : null,
    state.assetClass !== "all" ? {
      key: "assetClass",
      label: `Asset: ${labelFor(assetClasses, state.assetClass)}`,
    } : null,
    state.category !== "all" ? {
      key: "category",
      label: `Category: ${labelFor(categories, state.category)}`,
    } : null,
    state.movement !== "all" ? {
      key: "movement",
      label: `Movement: ${labelFor(MOVEMENT_OPTIONS, state.movement)}`,
    } : null,
    state.sort !== "default" ? {
      key: "sort",
      label: `Sort: ${labelFor(SORT_OPTIONS, state.sort)}`,
    } : null,
  ].filter(Boolean);
  const clearCriterion = (key) => {
    if (key === "assetClass") {
      emit({ assetClass: DEFAULT_STATE.assetClass, category: DEFAULT_STATE.category }, "assetClass");
      return;
    }
    emit({ [key]: DEFAULT_STATE[key] }, "chip");
  };

  return (
    <>
      {boards.boards.length ? (
        <ToolbarField label="Board" modifier="board">
          <BoardSwitcher
            boards={boards.boards}
            activeBoardId={boards.activeBoardId}
            portalContainer={portalContainer}
            onSwitch={onBoardSwitch}
            onCreate={onBoardCreate}
            onRename={onBoardRename}
            onDuplicate={onBoardDuplicate}
            onDelete={onBoardDelete}
            onDialogOpenChange={onBoardDialogOpenChange}
          />
        </ToolbarField>
      ) : null}
      <ToolbarField label="Filter" modifier="search">
        <TextField
          id="board-filter"
          type="search"
          icon={searchIcon}
          placeholder="Filter board…"
          autoComplete="off"
          aria-label="Filter board"
          value={state.search}
          onChange={(event) => emit({ search: event.target.value }, "search")}
        />
      </ToolbarField>
      <ToolbarField label="Asset class">
        <Select
          aria-label="Asset class"
          className="mm-toolbar__select"
          container={portalContainer}
          options={assetClasses}
          value={state.assetClass}
          onValueChange={(value) => emit({ assetClass: value, category: "all" }, "assetClass")}
        />
      </ToolbarField>
      <ToolbarField label="Category">
        <Select
          aria-label="Category"
          className="mm-toolbar__select"
          container={portalContainer}
          options={categories}
          value={state.category}
          onValueChange={(value) => emit({ category: value }, "category")}
        />
      </ToolbarField>
      <ToolbarField label="Movement">
        <Select
          aria-label="Movement"
          className="mm-toolbar__select"
          container={portalContainer}
          options={MOVEMENT_OPTIONS}
          value={state.movement}
          onValueChange={(value) => emit({ movement: value }, "movement")}
        />
      </ToolbarField>
      <ToolbarField label="Sort">
        <Select
          aria-label="Sort"
          className="mm-toolbar__select"
          container={portalContainer}
          options={SORT_OPTIONS}
          value={state.sort}
          onValueChange={(value) => emit({ sort: value }, "sort")}
        />
      </ToolbarField>
      {activeCriteria.length ? (
        <div className="mm-filter-chips" role="group" aria-label="Active filters and sorting">
          <span className="mm-filter-chips__label">Active</span>
          {activeCriteria.map((criterion) => (
            <button
              className="mm-filter-chip"
              key={criterion.key}
              type="button"
              aria-label={`Remove ${criterion.label}`}
              onClick={() => clearCriterion(criterion.key)}
            >
              <span>{criterion.label}</span>
              <span className="mm-filter-chip__remove" aria-hidden="true">×</span>
            </button>
          ))}
          <button
            className="mm-filter-chips__reset"
            type="button"
            onClick={() => emit({ ...DEFAULT_STATE }, "reset")}
          >
            Reset all
          </button>
        </div>
      ) : null}
    </>
  );
});
