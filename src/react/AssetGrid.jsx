import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import {
  BOARD_NEWS_ID,
  DEFAULT_NEWS_POSITION,
  columnsForBoardWidth,
  packBoardLayout,
  visibleBoardSequence,
} from "../ui/models/boardLayout.js";
import {
  REDUCED_MOTION_QUERY,
  animateBoardFlip,
  measureBoardCells,
  prefersReducedMotion,
} from "../ui/motion/boardMotion.js";
import { createGridStore } from "./gridStore.js";
import { AssetTileCell } from "./AssetTileCell.jsx";
import { NewsCell } from "./NewsCell.jsx";

const POINTER_DRAG_THRESHOLD = 6;
const TOUCH_HOLD_MS = 340;
const TOUCH_HOLD_TOLERANCE = 10;
const REFLOW_DURATION_MS = 190;
const SWAP_TRAVEL = 14;
const DROP_OPTIONS = Object.freeze({ duration: 280, easing: "cubic-bezier(.2, .85, .25, 1)" });
const SETTLE_TIMEOUT_MS = 1_200;

function placementStyle(placement) {
  if (!placement) return undefined;
  return {
    gridColumnStart: placement.column,
    gridColumnEnd: `span ${placement.span.columns}`,
    gridRowStart: placement.row,
    gridRowEnd: `span ${placement.span.rows}`,
  };
}

function layoutCellFrom(event) {
  return event.currentTarget.closest?.("[data-layout-id]") || null;
}

function sameList(current, next) {
  return Array.isArray(current)
    && Array.isArray(next)
    && current.length === next.length
    && current.every((value, index) => value === next[index]);
}

function sameMap(current, next) {
  if (!(current instanceof Map) || !(next instanceof Map) || current.size !== next.size) return false;
  for (const [key, value] of next) {
    if (current.get(key) !== value) return false;
  }
  return true;
}

function scrollOffset(view) {
  return { x: view?.scrollX || 0, y: view?.scrollY || 0 };
}

function restingGeometry(container) {
  const view = container?.ownerDocument?.defaultView;
  const { x, y } = scrollOffset(view);
  return { cells: measureBoardCells(container), scrollX: x, scrollY: y };
}

function restingTargetAt(geometry, view, clientX, clientY, draggedId) {
  if (!geometry?.cells?.size) return null;
  const { x: scrollX, y: scrollY } = scrollOffset(view);
  const pointX = clientX + scrollX - geometry.scrollX;
  const pointY = clientY + scrollY - geometry.scrollY;
  for (const [itemId, cell] of geometry.cells) {
    if (itemId === draggedId) continue;
    if (
      pointX >= cell.left && pointX < cell.left + cell.width
      && pointY >= cell.top && pointY < cell.top + cell.height
    ) return itemId;
  }
  return null;
}

function previewSequenceFor(sequence, itemId, insertionIndex) {
  const remaining = sequence.filter((candidate) => candidate !== itemId);
  if (remaining.length === sequence.length) return sequence;
  remaining.splice(Math.min(Math.max(0, insertionIndex), remaining.length), 0, itemId);
  return remaining;
}

export const AssetGrid = forwardRef(function AssetGrid(
  {
    onSelectTile,
    onNewsRetry,
    onReorder,
    onNewsOpenChange,
    initialLayout,
    containerElement,
  },
  ref,
) {
  const store = useMemo(() => createGridStore(), []);
  const [order, setOrder] = useState([]);
  const [indexById, setIndexById] = useState(() => new Map());
  const [tiers, setTiers] = useState(() => new Map());
  const [newsState, setNewsState] = useState({ status: "idle", articles: [] });
  const [layout, setLayout] = useState(() => ({
    newsPosition: initialLayout?.newsPosition ?? DEFAULT_NEWS_POSITION,
    newsOpen: initialLayout?.newsOpen !== false,
  }));
  const [columns, setColumns] = useState(() => columnsForBoardWidth(
    containerElement?.getBoundingClientRect?.().width,
    containerElement?.classList?.contains("single-tile-mode"),
  ));
  const [gesture, setGesture] = useState(null);
  const [announcement, setAnnouncement] = useState("");
  const sequenceRef = useRef([]);
  const tiersRef = useRef(new Map());
  const restingGeometryRef = useRef(null);
  const placementStyleCacheRef = useRef(new Map());
  const gestureRef = useRef(null);
  const pointerRef = useRef(null);
  const suppressHandleClickRef = useRef(false);
  const suppressTileClickRef = useRef(false);
  const previousMeasurementsRef = useRef(new Map());
  const unpaintedMeasurementsRef = useRef(new Map());
  const paintFrameRef = useRef(null);
  const activeAnimationsRef = useRef(new Set());
  const observedBoardWidthRef = useRef(null);
  const columnsRef = useRef(columns);
  const skipNextFlipRef = useRef(false);
  const [reducedMotion, setReducedMotion] = useState(() => prefersReducedMotion(containerElement));
  columnsRef.current = columns;

  const cancelActiveAnimations = useCallback(() => {
    for (const { element, animation } of activeAnimationsRef.current) {
      animation.cancel?.();
      delete element.dataset.layoutAnimating;
    }
    activeAnimationsRef.current.clear();
  }, []);

  useImperativeHandle(ref, () => ({
    applyBatch: (entries) => flushSync(() => store.applyBatch(entries)),
    setOrder: (next) => flushSync(() => setOrder(
      (current) => sameList(current, next) ? current : next,
    )),
    setIndexById: (next) => flushSync(() => setIndexById(
      (current) => sameMap(current, next) ? current : next,
    )),
    setTiers: (next) => flushSync(() => setTiers(
      (current) => sameMap(current, next) ? current : next,
    )),
    setNewsState: (next) => flushSync(() => setNewsState(next)),
    setLayoutState: (next) => flushSync(() => setLayout((current) => ({ ...current, ...next }))),
    remove: (instrumentId) => flushSync(() => store.remove(instrumentId)),
  }), [store]);

  useLayoutEffect(() => {
    if (!containerElement) return undefined;
    const view = containerElement.ownerDocument?.defaultView;
    observedBoardWidthRef.current = (
      containerElement.getBoundingClientRect?.().width || containerElement.clientWidth
    );
    const update = () => {
      const width = containerElement.getBoundingClientRect?.().width || containerElement.clientWidth;
      const nextColumns = columnsForBoardWidth(
        width,
        containerElement.classList.contains("single-tile-mode"),
      );
      const boardShrank = Number.isFinite(observedBoardWidthRef.current)
        && width < observedBoardWidthRef.current - 1;
      if (boardShrank) {
        cancelActiveAnimations();
        if (nextColumns !== columnsRef.current) skipNextFlipRef.current = true;
      }
      observedBoardWidthRef.current = width;
      columnsRef.current = nextColumns;
      setColumns(nextColumns);
    };
    update();
    const resizeObserver = typeof view?.ResizeObserver === "function"
      ? new view.ResizeObserver(update)
      : null;
    resizeObserver?.observe(containerElement);
    const mutationObserver = typeof view?.MutationObserver === "function"
      ? new view.MutationObserver(update)
      : null;
    mutationObserver?.observe(containerElement, { attributes: true, attributeFilter: ["class"] });
    view?.addEventListener?.("resize", update);
    return () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      view?.removeEventListener?.("resize", update);
    };
  }, [cancelActiveAnimations, containerElement]);

  useEffect(() => {
    const view = containerElement?.ownerDocument?.defaultView;
    const preference = view?.matchMedia?.(REDUCED_MOTION_QUERY);
    if (!preference) return undefined;
    const update = () => setReducedMotion(preference.matches);
    update();
    preference.addEventListener?.("change", update);
    return () => preference.removeEventListener?.("change", update);
  }, [containerElement]);

  const handleSelect = useCallback(
    (index, context) => onSelectTile?.(index, context),
    [onSelectTile],
  );
  const labelForItem = useCallback((itemId) => {
    if (itemId === BOARD_NEWS_ID) return "Latest news";
    const { viewModel } = store.getSnapshot(itemId);
    return viewModel?.displaySymbol || viewModel?.name || itemId;
  }, [store]);
  const hasNewsInstruments = newsState.instrumentLabels instanceof Map
    ? newsState.instrumentLabels.size > 0
    : Boolean(newsState.instrumentLabels);
  const hasBoard = indexById.size > 0 || order.length > 0 || hasNewsInstruments;
  const filteredToNothing = indexById.size > 0 && order.length === 0;
  const sequence = useMemo(() => visibleBoardSequence({
    visibleInstrumentIds: order,
    indexById,
    newsPosition: layout.newsPosition,
    includeNews: hasBoard && !filteredToNothing,
  }), [filteredToNothing, hasBoard, indexById, layout.newsPosition, order]);
  const previewSequence = useMemo(() => (
    gesture ? previewSequenceFor(sequence, gesture.itemId, gesture.insertionIndex) : sequence
  ), [gesture, sequence]);
  const activeTiers = gesture && !gesture.settling ? gesture.tiers : tiers;
  const placements = useMemo(() => {
    const newsRows = newsState.articles?.length ? 6 : 2;
    const spans = new Map([[
      BOARD_NEWS_ID,
      layout.newsOpen
        ? { columns: columns <= 3 ? columns : 2, rows: newsRows }
        : { columns: 1, rows: 1 },
    ]]);
    return new Map(packBoardLayout({
      sequence: previewSequence,
      tiers: activeTiers,
      columns,
      spans,
    }).map((placement) => [placement.instrumentId, placement]));
  }, [activeTiers, columns, layout.newsOpen, newsState.articles, previewSequence]);

  sequenceRef.current = sequence;
  tiersRef.current = tiers;
  gestureRef.current = gesture;

  useEffect(() => () => {
    pointerRef.current?.detach?.();
    pointerRef.current = null;
    gestureRef.current = null;
  }, []);

  useEffect(() => {
    if (!containerElement?.addEventListener) return undefined;
    const holdPage = (event) => {
      if (gestureRef.current?.mode === "touch" && event.cancelable) event.preventDefault();
    };
    containerElement.addEventListener("touchmove", holdPage, { passive: false });
    return () => containerElement.removeEventListener("touchmove", holdPage);
  }, [containerElement]);

  const publishGesture = useCallback((next) => {
    gestureRef.current = next;
    setGesture(next);
  }, []);

  const beginGesture = useCallback((itemId, mode) => {
    const currentSequence = sequenceRef.current;
    const sourceIndex = currentSequence.indexOf(itemId);
    if (sourceIndex < 0) return null;
    const remainingLength = currentSequence.length - 1;
    const next = {
      itemId,
      mode,
      insertionIndex: Math.min(sourceIndex, remainingLength),
      tiers: tiersRef.current,
      settling: false,
    };
    publishGesture(next);
    if (mode === "keyboard") {
      setAnnouncement(
        `${labelForItem(itemId)} grabbed. `
        + "Use arrow keys to choose a position, then press Space to drop.",
      );
    }
    return next;
  }, [labelForItem, publishGesture]);

  const captureVisualPositions = useCallback(() => {
    if (!containerElement) return;
    previousMeasurementsRef.current = measureBoardCells(containerElement);
  }, [containerElement]);

  const updateInsertion = useCallback((insertionIndex) => {
    const current = gestureRef.current;
    if (!current || current.settling) return false;
    const maximum = Math.max(0, sequenceRef.current.length - 1);
    const bounded = Math.min(Math.max(0, insertionIndex), maximum);
    if (bounded === current.insertionIndex) return false;
    captureVisualPositions();
    publishGesture({ ...current, insertionIndex: bounded });
    if (current.mode === "keyboard") {
      setAnnouncement(`Position ${bounded + 1} of ${sequenceRef.current.length}.`);
    }
    return true;
  }, [captureVisualPositions, publishGesture]);

  const cancelGesture = useCallback(() => {
    const current = gestureRef.current;
    if (!current) return;
    captureVisualPositions();
    publishGesture(null);
    setAnnouncement("Reorder cancelled.");
  }, [captureVisualPositions, publishGesture]);

  const commitGesture = useCallback(() => {
    const current = gestureRef.current;
    if (!current || current.settling) return;
    const remaining = sequenceRef.current.filter((itemId) => itemId !== current.itemId);
    const beforeId = remaining[current.insertionIndex] || null;
    publishGesture({ ...current, settling: true });
    setAnnouncement(
      `${labelForItem(current.itemId)} dropped `
      + `at position ${current.insertionIndex + 1}.`,
    );
    queueMicrotask(() => onReorder?.({ itemId: current.itemId, beforeId }));
  }, [labelForItem, onReorder, publishGesture]);

  const resolveInsertion = useCallback((pointer, clientX, clientY) => {
    const current = gestureRef.current;
    if (!current) return;
    if (pointer.awaitingLayout) return;
    const travelled = Math.hypot(clientX - pointer.settledX, clientY - pointer.settledY);
    if (travelled < SWAP_TRAVEL) return;
    const view = containerElement?.ownerDocument?.defaultView;
    const targetId = restingTargetAt(restingGeometryRef.current, view, clientX, clientY, pointer.itemId);
    if (!targetId) return;
    const remaining = sequenceRef.current.filter((candidate) => candidate !== pointer.itemId);
    const targetIndex = remaining.indexOf(targetId);
    if (targetIndex < 0) return;
    const next = targetIndex >= current.insertionIndex ? targetIndex + 1 : targetIndex;
    if (next === current.insertionIndex) return;
    if (!updateInsertion(next)) return;
    pointer.settledX = clientX;
    pointer.settledY = clientY;
    pointer.awaitingLayout = true;
  }, [containerElement, updateInsertion]);

  const applyDragTransform = useCallback((pointer) => {
    if (!pointer.cell) return;
    const { x: scrollX, y: scrollY } = scrollOffset(pointer.cell.ownerDocument?.defaultView);
    const x = pointer.lastX + scrollX - pointer.grabOffsetX - pointer.baseLeft;
    const y = pointer.lastY + scrollY - pointer.grabOffsetY - pointer.baseTop;
    pointer.cell.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }, []);

  const trackDrag = useCallback((pointer, clientX, clientY) => {
    pointer.lastX = clientX;
    pointer.lastY = clientY;
    resolveInsertion(pointer, clientX, clientY);
    applyDragTransform(pointer);
  }, [applyDragTransform, resolveInsertion]);

  const startPointerDrag = useCallback((pointer) => {
    cancelActiveAnimations();
    const geometry = restingGeometry(containerElement);
    restingGeometryRef.current = geometry;
    const measured = geometry.cells.get(pointer.itemId);
    const left = (measured?.left ?? 0) + geometry.scrollX;
    const top = (measured?.top ?? 0) + geometry.scrollY;
    pointer.active = true;
    pointer.holdTimer = null;
    pointer.grabOffsetX = pointer.startX + geometry.scrollX - left;
    pointer.grabOffsetY = pointer.startY + geometry.scrollY - top;
    pointer.baseLeft = left;
    pointer.baseTop = top;
    pointer.lastX = pointer.startX;
    pointer.lastY = pointer.startY;
    pointer.settledX = pointer.startX;
    pointer.settledY = pointer.startY;
    pointer.awaitingLayout = false;
    beginGesture(pointer.itemId, pointer.mode);
  }, [beginGesture, cancelActiveAnimations, containerElement]);

  const clearHoldTimer = useCallback((pointer) => {
    if (!pointer?.holdTimer) return;
    pointer.cell?.ownerDocument?.defaultView?.clearTimeout?.(pointer.holdTimer);
    pointer.holdTimer = null;
  }, []);

  const endPointerTracking = useCallback((pointer) => {
    clearHoldTimer(pointer);
    pointer?.detach?.();
    if (pointerRef.current === pointer) pointerRef.current = null;
  }, [clearHoldTimer]);

  const releaseDraggedCell = useCallback((pointer) => {
    clearHoldTimer(pointer);
    const cell = pointer?.cell;
    if (!cell?.getBoundingClientRect) return;
    const from = cell.getBoundingClientRect();
    cell.style.transform = "";
    const to = cell.getBoundingClientRect();
    if (!(to.width > 0 && to.height > 0)) return;
    previousMeasurementsRef.current.set(pointer.itemId, {
      element: cell,
      left: to.left,
      top: to.top,
      width: to.width,
      height: to.height,
    });
    const deltaX = from.left - to.left;
    const deltaY = from.top - to.top;
    if (reducedMotion || typeof cell.animate !== "function") return;
    if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) return;
    const item = {
      element: cell,
      animation: cell.animate([
        { transform: `translate3d(${deltaX}px, ${deltaY}px, 0)` },
        { transform: "translate3d(0, 0, 0)" },
      ], DROP_OPTIONS),
    };
    cell.dataset.layoutAnimating = "true";
    activeAnimationsRef.current.add(item);
    const finish = () => {
      if (!activeAnimationsRef.current.has(item)) return;
      activeAnimationsRef.current.delete(item);
      delete cell.dataset.layoutAnimating;
    };
    item.animation.finished?.then(finish, finish);
  }, [clearHoldTimer, reducedMotion]);

  const handlePointerMove = useCallback((pointer, event) => {
    if (pointerRef.current !== pointer || pointer.pointerId !== event.pointerId) return;
    if (!pointer.active) {
      const distance = Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY);
      if (pointer.holdTimer) {
        if (distance > TOUCH_HOLD_TOLERANCE) endPointerTracking(pointer);
        return;
      }
      if (distance < POINTER_DRAG_THRESHOLD) return;
      startPointerDrag(pointer);
    }
    if (event.cancelable) event.preventDefault();
    trackDrag(pointer, event.clientX, event.clientY);
  }, [endPointerTracking, startPointerDrag, trackDrag]);

  const handlePointerUp = useCallback((pointer, event) => {
    if (pointerRef.current !== pointer || pointer.pointerId !== event.pointerId) return;
    const wasDragging = pointer.active;
    if (wasDragging) releaseDraggedCell(pointer);
    endPointerTracking(pointer);
    if (!wasDragging) return;
    suppressHandleClickRef.current = true;
    suppressTileClickRef.current = true;
    commitGesture();
  }, [commitGesture, endPointerTracking, releaseDraggedCell]);

  const handlePointerCancel = useCallback((pointer, event) => {
    if (pointerRef.current !== pointer || pointer.pointerId !== event.pointerId) return;
    const wasDragging = pointer.active;
    if (wasDragging) releaseDraggedCell(pointer);
    endPointerTracking(pointer);
    if (!wasDragging) return;
    cancelGesture();
  }, [cancelGesture, endPointerTracking, releaseDraggedCell]);

  const handlePointerDown = useCallback((itemId, event, { hold = false } = {}) => {
    if (event.button !== 0 || gestureRef.current) return;
    if (pointerRef.current) endPointerTracking(pointerRef.current);
    const cell = layoutCellFrom(event);
    const documentElement = cell?.ownerDocument;
    if (!cell || !documentElement?.addEventListener) return;
    suppressTileClickRef.current = false;
    const pointer = {
      itemId,
      cell,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      mode: event.pointerType === "touch" ? "touch" : "pointer",
      active: false,
      holdTimer: null,
      detach: null,
    };
    const move = (native) => handlePointerMove(pointer, native);
    const up = (native) => handlePointerUp(pointer, native);
    const cancel = (native) => handlePointerCancel(pointer, native);
    documentElement.addEventListener("pointermove", move);
    documentElement.addEventListener("pointerup", up);
    documentElement.addEventListener("pointercancel", cancel);
    pointer.detach = () => {
      documentElement.removeEventListener("pointermove", move);
      documentElement.removeEventListener("pointerup", up);
      documentElement.removeEventListener("pointercancel", cancel);
    };
    pointerRef.current = pointer;

    if (!hold || event.pointerType !== "touch") return;
    const view = documentElement.defaultView;
    if (typeof view?.setTimeout !== "function") return;
    pointer.holdTimer = view.setTimeout(() => {
      if (pointerRef.current !== pointer || pointer.active) return;
      startPointerDrag(pointer);
    }, TOUCH_HOLD_MS);
  }, [
    endPointerTracking,
    handlePointerCancel,
    handlePointerMove,
    handlePointerUp,
    startPointerDrag,
  ]);

  const handleTileClickCapture = useCallback((event) => {
    if (!suppressTileClickRef.current) return;
    suppressTileClickRef.current = false;
    if (!event.target?.closest?.("[data-reorder-handle]")) {
      suppressHandleClickRef.current = false;
    }
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const handleReorderClick = useCallback((itemId, event) => {
    event.preventDefault();
    if (suppressHandleClickRef.current) {
      suppressHandleClickRef.current = false;
      return;
    }
    const current = gestureRef.current;
    if (!current) {
      beginGesture(itemId, "keyboard");
      return;
    }
    if (current.itemId === itemId && current.mode === "keyboard") commitGesture();
  }, [beginGesture, commitGesture]);

  const handleReorderBlur = useCallback((itemId) => {
    const current = gestureRef.current;
    if (current?.itemId === itemId && current.mode === "keyboard") cancelGesture();
  }, [cancelGesture]);

  const handleReorderKeyDown = useCallback((itemId, event) => {
    const current = gestureRef.current;
    if (!current) {
      if (event.key !== " " && event.key !== "Enter") return;
      event.preventDefault();
      beginGesture(itemId, "keyboard");
      return;
    }
    if (current.itemId !== itemId || current.mode !== "keyboard") return;
    if (event.key === "Escape") {
      event.preventDefault();
      cancelGesture();
      return;
    }
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      commitGesture();
      return;
    }
    const deltas = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };
    if (Object.hasOwn(deltas, event.key)) {
      event.preventDefault();
      updateInsertion(current.insertionIndex + deltas[event.key]);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      updateInsertion(event.key === "Home" ? 0 : sequenceRef.current.length - 1);
    }
  }, [beginGesture, cancelGesture, commitGesture, updateInsertion]);

  const handleNewsToggle = useCallback(() => {
    const next = !layout.newsOpen;
    setLayout((current) => ({ ...current, newsOpen: next }));
    queueMicrotask(() => onNewsOpenChange?.(next));
  }, [layout.newsOpen, onNewsOpenChange]);

  const held = gesture && !gesture.settling ? gesture.itemId : null;

  const placementStyles = useMemo(() => {
    const cache = placementStyleCacheRef.current;
    const styles = new Map();
    for (const [itemId, placement] of placements) {
      const key = `${placement.column}:${placement.row}:${placement.span.columns}:${placement.span.rows}`;
      const cached = cache.get(itemId);
      const style = cached?.key === key ? cached.style : placementStyle(placement);
      cache.set(itemId, { key, style });
      styles.set(itemId, style);
    }
    for (const itemId of cache.keys()) {
      if (!styles.has(itemId)) cache.delete(itemId);
    }
    return styles;
  }, [placements]);

  useLayoutEffect(() => {
    cancelActiveAnimations();

    const pointer = pointerRef.current;
    const dragging = pointer?.active && pointer.cell?.isConnected ? pointer : null;
    if (dragging) dragging.cell.style.transform = "";

    const currentMeasurements = measureBoardCells(containerElement);
    const skipFlip = skipNextFlipRef.current;
    skipNextFlipRef.current = false;
    if (!reducedMotion && !skipFlip) {
      const animations = animateBoardFlip(previousMeasurementsRef.current, currentMeasurements, {
        bounds: containerElement?.getBoundingClientRect?.(),
        exclude: dragging ? [dragging.itemId] : null,
        duration: gestureRef.current ? REFLOW_DURATION_MS : undefined,
      });
      for (const item of animations) {
        const { element, animation } = item;
        element.dataset.layoutAnimating = "true";
        activeAnimationsRef.current.add(item);
        const finish = () => {
          if (!activeAnimationsRef.current.has(item)) return;
          activeAnimationsRef.current.delete(item);
          delete element.dataset.layoutAnimating;
        };
        animation.finished?.then(finish, finish);
      }
    }
    unpaintedMeasurementsRef.current = currentMeasurements;
    const frameView = containerElement?.ownerDocument?.defaultView;
    if (typeof frameView?.requestAnimationFrame !== "function") {
      previousMeasurementsRef.current = currentMeasurements;
    } else if (paintFrameRef.current === null) {
      paintFrameRef.current = frameView.requestAnimationFrame(() => {
        paintFrameRef.current = null;
        previousMeasurementsRef.current = unpaintedMeasurementsRef.current;
      });
    }

    const { x: scrollX, y: scrollY } = scrollOffset(containerElement?.ownerDocument?.defaultView);
    restingGeometryRef.current = { cells: currentMeasurements, scrollX, scrollY };

    if (dragging) {
      dragging.awaitingLayout = false;
      const measured = currentMeasurements.get(dragging.itemId);
      if (measured) {
        dragging.baseLeft = measured.left + scrollX;
        dragging.baseTop = measured.top + scrollY;
      }
      applyDragTransform(dragging);
    }
  }, [
    applyDragTransform,
    cancelActiveAnimations,
    containerElement,
    placements,
    reducedMotion,
    sequence,
  ]);

  useEffect(() => {
    if (!gesture?.settling) return undefined;
    if (sameList(previewSequence, sequence)) {
      publishGesture(null);
      return undefined;
    }
    const view = containerElement?.ownerDocument?.defaultView;
    const timer = view?.setTimeout?.(() => publishGesture(null), SETTLE_TIMEOUT_MS);
    return () => view?.clearTimeout?.(timer);
  }, [containerElement, gesture, previewSequence, publishGesture, sequence]);

  useEffect(() => () => {
    cancelActiveAnimations();
    containerElement?.ownerDocument?.defaultView?.cancelAnimationFrame?.(paintFrameRef.current);
    paintFrameRef.current = null;
    previousMeasurementsRef.current.clear();
    unpaintedMeasurementsRef.current.clear();
  }, [cancelActiveAnimations, containerElement]);

  const bind = useCallback((handler, options) => (event) => {
    const itemId = layoutCellFrom(event)?.dataset.layoutId;
    if (itemId) handler(itemId, event, options);
  }, []);

  const tileDragHandlers = useMemo(() => ({
    onPointerDown: bind(handlePointerDown, { hold: true }),
    onClickCapture: handleTileClickCapture,
  }), [bind, handlePointerDown, handleTileClickCapture]);

  const keyboardReorderHandlers = useMemo(() => ({
    onReorderKeyDown: bind(handleReorderKeyDown),
    onReorderClick: bind(handleReorderClick),
    onReorderBlur: bind(handleReorderBlur),
  }), [bind, handleReorderBlur, handleReorderClick, handleReorderKeyDown]);

  const newsHandleHandlers = useMemo(() => ({
    ...keyboardReorderHandlers,
    onReorderPointerDown: bind(handlePointerDown),
  }), [bind, handlePointerDown, keyboardReorderHandlers]);

  return (
    <>
      <p className="sr-only" id="board-reorder-instructions">
        Press Space to grab. Use arrow keys to move. Press Space again to drop, or Escape to cancel.
      </p>
      <p className="sr-only" aria-live="assertive">{announcement}</p>
      {sequence.map((itemId) => itemId === BOARD_NEWS_ID ? (
        <NewsCell
          key={itemId}
          {...newsState}
          {...newsHandleHandlers}
          grabbed={held === itemId}
          hasBoard={hasBoard}
          open={layout.newsOpen}
          placementStyle={placementStyles.get(itemId)}
          onRetry={onNewsRetry}
          onToggleOpen={handleNewsToggle}
        />
      ) : (
        <AssetTileCell
          key={itemId}
          {...keyboardReorderHandlers}
          dragHandlers={tileDragHandlers}
          grabbed={held === itemId}
          instrumentId={itemId}
          index={indexById.get(itemId)}
          tier={activeTiers.get(itemId) || "compact"}
          placementStyle={placementStyles.get(itemId)}
          store={store}
          onSelect={handleSelect}
        />
      ))}
    </>
  );
});
