export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
export const DETAIL_VIEW_TRANSITION_NAME = "marketmap-instrument-detail";

const FLIP_OPTIONS = Object.freeze({
  duration: 240,
  easing: "cubic-bezier(.2, .8, .2, 1)",
});

function usableRect(rect) {
  return rect
    && Number.isFinite(rect.left)
    && Number.isFinite(rect.top)
    && Number.isFinite(rect.width)
    && Number.isFinite(rect.height)
    && rect.width > 0
    && rect.height > 0;
}

function viewFor(target) {
  return target?.ownerDocument?.defaultView || target?.defaultView || null;
}

export function prefersReducedMotion(target) {
  const view = viewFor(target);
  return Boolean(view?.matchMedia?.(REDUCED_MOTION_QUERY).matches);
}

export function measureBoardCells(container) {
  const measured = new Map();
  if (!container?.querySelectorAll) return measured;
  for (const element of container.querySelectorAll("[data-layout-id]")) {
    const rect = element.getBoundingClientRect?.();
    if (!usableRect(rect)) continue;
    measured.set(element.dataset.layoutId, {
      element,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    });
  }
  return measured;
}

function reliableDelta(before, after) {
  if (!before || !after || before.element !== after.element || !after.element?.isConnected) {
    return false;
  }
  const scaleX = before.width / after.width;
  const scaleY = before.height / after.height;
  const deltaX = before.left - after.left;
  const deltaY = before.top - after.top;
  return Number.isFinite(scaleX)
    && Number.isFinite(scaleY)
    && Number.isFinite(deltaX)
    && Number.isFinite(deltaY)
    && scaleX >= 0.25
    && scaleX <= 4
    && scaleY >= 0.25
    && scaleY <= 4
    && Math.abs(deltaX) <= 20_000
    && Math.abs(deltaY) <= 20_000;
}

function startsInsideHorizontalBounds(before, bounds) {
  if (!bounds) return true;
  return before.left >= bounds.left - 1
    && before.left + before.width <= bounds.right + 1;
}

export function animateBoardFlip(
  beforeMeasurements,
  afterMeasurements,
  { bounds, exclude, duration } = {},
) {
  const animations = [];
  const skipped = exclude ? new Set(exclude) : null;
  const options = Number.isFinite(duration) && duration > 0
    ? { ...FLIP_OPTIONS, duration }
    : FLIP_OPTIONS;
  for (const [itemId, after] of afterMeasurements) {
    if (skipped?.has(itemId)) continue;
    const before = beforeMeasurements?.get(itemId);
    if (
      !reliableDelta(before, after)
      || !startsInsideHorizontalBounds(before, bounds)
      || typeof after.element.animate !== "function"
    ) continue;
    const deltaX = before.left - after.left;
    const deltaY = before.top - after.top;
    const scaleX = before.width / after.width;
    const scaleY = before.height / after.height;
    const moved = Math.abs(deltaX) >= 0.5 || Math.abs(deltaY) >= 0.5;
    const resized = Math.abs(scaleX - 1) >= 0.01 || Math.abs(scaleY - 1) >= 0.01;
    if (!moved && !resized) continue;

    const animation = after.element.animate([
      {
        transform: `translate(${deltaX}px, ${deltaY}px) scale(${scaleX}, ${scaleY})`,
        transformOrigin: "top left",
      },
      {
        transform: "translate(0, 0) scale(1, 1)",
        transformOrigin: "top left",
      },
    ], options);
    animations.push({ element: after.element, animation });
  }
  return animations;
}

function reliableTransitionSource(sourceElement) {
  if (!sourceElement?.isConnected || !sourceElement.style) return false;
  return usableRect(sourceElement.getBoundingClientRect?.());
}

export function openWithDetailTransition({
  document: documentElement,
  scopeElement,
  sourceElement,
  update,
}) {
  const runUpdate = typeof update === "function" ? update : () => undefined;
  if (
    typeof documentElement?.startViewTransition !== "function"
    || prefersReducedMotion(documentElement)
    || !reliableTransitionSource(sourceElement)
  ) {
    runUpdate();
    return null;
  }

  const previousName = sourceElement.style.getPropertyValue("view-transition-name");
  const previousScopeValue = scopeElement?.getAttribute?.("data-detail-view-transition");
  let updateStarted = false;
  let cleaned = false;
  const restore = () => {
    if (cleaned) return;
    cleaned = true;
    if (previousName) {
      sourceElement.style.setProperty("view-transition-name", previousName);
    } else {
      sourceElement.style.removeProperty("view-transition-name");
    }
    if (scopeElement) {
      if (previousScopeValue === null) scopeElement.removeAttribute("data-detail-view-transition");
      else scopeElement.setAttribute("data-detail-view-transition", previousScopeValue);
    }
  };

  sourceElement.style.setProperty("view-transition-name", DETAIL_VIEW_TRANSITION_NAME);
  scopeElement?.setAttribute?.("data-detail-view-transition", "true");
  try {
    const transition = documentElement.startViewTransition(() => {
      updateStarted = true;
      sourceElement.style.removeProperty("view-transition-name");
      return runUpdate();
    });
    Promise.resolve(transition?.finished).then(restore, restore);
    return transition;
  } catch {
    restore();
    if (!updateStarted) runUpdate();
    return null;
  }
}
