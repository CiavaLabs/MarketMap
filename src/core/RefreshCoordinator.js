const REFRESH_POLICIES = Object.freeze(["automatic", "manual"]);
const VISIBILITY_PAUSE_REASON = "visibility";

const defaultClock = Object.freeze({
  now: () => Date.now(),
});

const defaultTimer = Object.freeze({
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (id) => globalThis.clearTimeout(id),
});

function assertDependency(value, method, label) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`${label} must implement ${method}()`);
  }
}

function normalizeMinimumRefreshMs(value) {
  const milliseconds = value ?? 1_000;
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new TypeError("minimumRefreshMs must be a non-negative finite number");
  }
  return milliseconds;
}

function normalizeRefreshTime(value) {
  if (value == null) return null;
  const timestamp = value instanceof Date
    ? value.getTime()
    : typeof value === "number"
      ? value
      : Date.parse(value);
  if (!Number.isFinite(timestamp) || !Number.isFinite(new Date(timestamp).getTime())) {
    throw new TypeError("nextRefreshAt must be a Date, epoch milliseconds, ISO timestamp, or null");
  }
  return timestamp;
}

function createAbortError() {
  if (typeof DOMException === "function") {
    return new DOMException("Refresh coordinator destroyed", "AbortError");
  }
  const error = new Error("Refresh coordinator destroyed");
  error.name = "AbortError";
  return error;
}

export class RefreshCoordinator {
  constructor(options = {}) {
    if (typeof options.refresh !== "function") {
      throw new TypeError("RefreshCoordinator requires a refresh callback");
    }

    const refreshPolicy = options.refreshPolicy || "automatic";
    if (!REFRESH_POLICIES.includes(refreshPolicy)) {
      throw new TypeError(`refreshPolicy must be one of: ${REFRESH_POLICIES.join(", ")}`);
    }

    this.refresh = options.refresh;
    this.refreshPolicy = refreshPolicy;
    this.autoRefreshEnabled = refreshPolicy === "automatic";
    this.allowRefreshControl = options.allowRefreshControl !== false;
    this.allowManualRefresh = options.allowManualRefresh !== false;
    this.pauseWhenHidden = options.pauseWhenHidden !== false;
    this.minimumRefreshMs = normalizeMinimumRefreshMs(options.minimumRefreshMs);
    this.maximumRetryMs = normalizeMinimumRefreshMs(options.maximumRetryMs ?? 60_000);
    if (this.maximumRetryMs < this.minimumRefreshMs) {
      throw new TypeError("maximumRetryMs must be greater than or equal to minimumRefreshMs");
    }

    this.clock = typeof options.clock === "function"
      ? { now: options.clock }
      : options.clock || defaultClock;
    this.timer = options.timer || options.timers || defaultTimer;
    assertDependency(this.clock, "now", "clock");
    assertDependency(this.timer, "setTimeout", "timer");
    assertDependency(this.timer, "clearTimeout", "timer");

    this.visibilityTarget = options.visibilityTarget === undefined
      ? globalThis.document ?? null
      : options.visibilityTarget;
    this.onStateChange = typeof options.onStateChange === "function"
      ? options.onStateChange
      : null;
    this.onError = typeof options.onError === "function" ? options.onError : null;

    this.started = false;
    this.destroyed = false;
    this.pauseReasons = new Set();
    this.pendingRefreshReason = null;
    this.nextRefreshEpoch = null;
    this.nextRefreshAt = null;
    this.timerId = null;
    this.inFlight = null;
    this.refreshAbortController = null;
    this.lastResult = null;
    this.lastError = null;
    this.failureCount = 0;
    this.visibilityListenerAttached = false;
    this.handleVisibilityChange = () => {
      this.setVisibility(Boolean(this.visibilityTarget?.hidden));
    };
  }

  start(options = {}) {
    if (this.destroyed) return Promise.resolve(null);
    if (this.started) return this.inFlight || Promise.resolve(this.lastResult);

    this.started = true;
    this.#attachVisibilityListener();
    if (hasOwn(options, "nextRefreshAt")) {
      this.#setNextRefreshAt(options.nextRefreshAt, false);
    }
    if (this.pauseWhenHidden && this.visibilityTarget?.hidden) {
      this.pause(VISIBILITY_PAUSE_REASON);
    }

    this.#emitState();
    if (options.immediate !== false) {
      return this.#requestRefresh("initial");
    }
    this.#schedule();
    return Promise.resolve(null);
  }

  refreshNow() {
    if (this.destroyed || !this.allowManualRefresh) return Promise.resolve(null);
    return this.#requestRefresh("manual");
  }

  setAutoRefreshEnabled(enabled) {
    if (this.destroyed || !this.allowRefreshControl) return false;
    const nextValue = Boolean(enabled);
    if (this.autoRefreshEnabled === nextValue) return true;

    this.autoRefreshEnabled = nextValue;
    if (nextValue) this.#schedule();
    else this.#clearTimer();
    this.#emitState();
    return true;
  }

  setNextRefreshAt(value) {
    if (this.destroyed) return false;
    this.#setNextRefreshAt(value, true);
    return true;
  }

  pause(reason = "host") {
    if (this.destroyed || typeof reason !== "string" || !reason.trim()) return false;
    const sizeBefore = this.pauseReasons.size;
    this.pauseReasons.add(reason.trim());
    this.#clearTimer();
    if (this.pauseReasons.size !== sizeBefore) this.#emitState();
    return this.pauseReasons.size !== sizeBefore;
  }

  resume(reason = "host") {
    if (this.destroyed || typeof reason !== "string" || !reason.trim()) return false;
    if (!this.pauseReasons.delete(reason.trim())) return false;

    this.#emitState();
    if (this.pauseReasons.size > 0) return true;

    if (this.pendingRefreshReason) {
      const pendingReason = this.pendingRefreshReason;
      this.pendingRefreshReason = null;
      void this.#requestRefresh(pendingReason).catch(() => {});
    } else if (
      this.started
      && this.autoRefreshEnabled
      && this.nextRefreshEpoch !== null
      && this.nextRefreshEpoch <= this.clock.now()
    ) {
      void this.#requestRefresh("resume").catch(() => {});
    } else {
      this.#schedule();
    }
    return true;
  }

  setVisibility(hidden) {
    if (!this.pauseWhenHidden) return false;
    return hidden
      ? this.pause(VISIBILITY_PAUSE_REASON)
      : this.resume(VISIBILITY_PAUSE_REASON);
  }

  getState() {
    return Object.freeze({
      started: this.started,
      destroyed: this.destroyed,
      refreshPolicy: this.autoRefreshEnabled ? "automatic" : "manual",
      configuredRefreshPolicy: this.refreshPolicy,
      allowRefreshControl: this.allowRefreshControl,
      allowManualRefresh: this.allowManualRefresh,
      pauseWhenHidden: this.pauseWhenHidden,
      paused: this.pauseReasons.size > 0,
      pauseReasons: Object.freeze([...this.pauseReasons]),
      refreshing: !this.destroyed && Boolean(this.inFlight),
      nextRefreshAt: this.nextRefreshAt,
      lastError: this.lastError,
      failureCount: this.failureCount,
    });
  }

  destroy() {
    if (this.destroyed) return false;
    this.destroyed = true;
    this.started = false;
    this.#clearTimer();
    this.#detachVisibilityListener();
    this.refreshAbortController?.abort(createAbortError());
    this.refreshAbortController = null;
    this.pauseReasons.clear();
    this.pendingRefreshReason = null;
    this.#emitState();
    return true;
  }

  #requestRefresh(reason) {
    if (this.destroyed) return Promise.resolve(null);
    if (this.pauseReasons.size > 0) {
      this.pendingRefreshReason ||= reason;
      return Promise.resolve(null);
    }
    if (this.inFlight) return this.inFlight;

    this.#clearTimer();
    this.pendingRefreshReason = null;
    const controller = new AbortController();
    this.refreshAbortController = controller;

    const run = Promise.resolve()
      .then(() => this.refresh({ reason, signal: controller.signal }))
      .then((result) => {
        this.lastResult = result;
        this.lastError = null;
        this.failureCount = 0;
        const nextRefreshAt = result?.meta?.nextRefreshAt ?? result?.nextRefreshAt ?? null;
        try {
          this.#setNextRefreshAt(nextRefreshAt, false);
        } catch {
          this.#setNextRefreshAt(null, false);
        }
        this.#emitState();
        return result;
      })
      .catch((error) => {
        if (this.destroyed || controller.signal.aborted) throw error;
        if (error?.superseded === true) {
          if (this.nextRefreshEpoch === null) {
            this.#setNextRefreshAt(this.clock.now() + Math.max(this.minimumRefreshMs, 1_000), false);
          }
          throw error;
        }
        this.lastError = error;
        this.failureCount += 1;
        const retryAfterMs = Number(error?.retryAfterMs);
        const exponentialDelay = Math.min(
          this.maximumRetryMs,
          Math.max(this.minimumRefreshMs, 1_000) * (2 ** (this.failureCount - 1)),
        );
        const retryDelay = Number.isFinite(retryAfterMs) && retryAfterMs >= 0
          ? Math.max(this.minimumRefreshMs, retryAfterMs)
          : exponentialDelay;
        this.#setNextRefreshAt(this.clock.now() + retryDelay, false);
        try {
          this.onError?.(error, { reason });
        } catch {}
        this.#emitState();
        throw error;
      })
      .finally(() => {
        if (this.inFlight === run) this.inFlight = null;
        if (this.refreshAbortController === controller) {
          this.refreshAbortController = null;
        }
        if (this.destroyed) return;
        this.#schedule();
        this.#emitState();
      });

    this.inFlight = run;
    this.#emitState();
    return run;
  }

  #setNextRefreshAt(value, shouldSchedule) {
    this.nextRefreshEpoch = normalizeRefreshTime(value);
    this.nextRefreshAt = this.nextRefreshEpoch === null
      ? null
      : new Date(this.nextRefreshEpoch).toISOString();
    if (shouldSchedule) this.#schedule();
    this.#emitState();
  }

  #schedule() {
    this.#clearTimer();
    if (
      this.destroyed
      || !this.started
      || !this.autoRefreshEnabled
      || this.pauseReasons.size > 0
      || this.inFlight
      || this.nextRefreshEpoch === null
    ) {
      return;
    }

    const delay = Math.max(
      this.minimumRefreshMs,
      this.nextRefreshEpoch - this.clock.now(),
    );
    this.timerId = this.timer.setTimeout(() => {
      this.timerId = null;
      return this.#requestRefresh("automatic").catch(() => null);
    }, delay);
  }

  #clearTimer() {
    if (this.timerId === null) return;
    this.timer.clearTimeout(this.timerId);
    this.timerId = null;
  }

  #attachVisibilityListener() {
    if (
      !this.pauseWhenHidden
      || this.visibilityListenerAttached
      || typeof this.visibilityTarget?.addEventListener !== "function"
    ) {
      return;
    }
    this.visibilityTarget.addEventListener("visibilitychange", this.handleVisibilityChange);
    this.visibilityListenerAttached = true;
  }

  #detachVisibilityListener() {
    if (!this.visibilityListenerAttached) return;
    this.visibilityTarget?.removeEventListener?.(
      "visibilitychange",
      this.handleVisibilityChange,
    );
    this.visibilityListenerAttached = false;
  }

  #emitState() {
    if (!this.onStateChange) return;
    try {
      this.onStateChange(this.getState());
    } catch {}
  }
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}
