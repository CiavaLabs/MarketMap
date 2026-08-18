const EMPTY_ENTRY = Object.freeze({ version: 0, viewModel: null, sparklineData: null, derivedState: "unavailable" });

export function createGridStore() {
  const entries = new Map();
  const listeners = new Map();

  function applyBatch(items = []) {
    for (const item of items) {
      const { instrumentId } = item;
      if (!instrumentId) continue;
      const previous = entries.get(instrumentId);
      entries.set(instrumentId, { ...item, version: (previous?.version || 0) + 1 });
      listeners.get(instrumentId)?.forEach((listener) => listener());
    }
  }

  function subscribe(instrumentId, listener) {
    let set = listeners.get(instrumentId);
    if (!set) {
      set = new Set();
      listeners.set(instrumentId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0 && listeners.get(instrumentId) === set) listeners.delete(instrumentId);
    };
  }

  function getSnapshot(instrumentId) {
    return entries.get(instrumentId) || EMPTY_ENTRY;
  }

  function remove(instrumentId) {
    entries.delete(instrumentId);
  }

  return { applyBatch, subscribe, getSnapshot, remove };
}
