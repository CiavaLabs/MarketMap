export class Lifecycle {
  constructor() {
    this.controller = new AbortController();
    this.timeouts = new Set();
    this.intervals = new Set();
    this.destroyed = false;
  }

  get signal() {
    return this.controller.signal;
  }

  listen(target, type, handler, options = {}) {
    if (!target?.addEventListener || this.destroyed) return () => {};
    target.addEventListener(type, handler, { ...options, signal: this.signal });
    return () => target.removeEventListener(type, handler, options);
  }

  timeout(callback, delay) {
    if (this.destroyed) return null;
    const id = setTimeout(() => {
      this.timeouts.delete(id);
      if (!this.destroyed) callback();
    }, delay);
    this.timeouts.add(id);
    return id;
  }

  clearTimeout(id) {
    if (id === null || id === undefined) return false;
    clearTimeout(id);
    return this.timeouts.delete(id);
  }

  interval(callback, delay) {
    if (this.destroyed) return null;
    const id = setInterval(() => {
      if (!this.destroyed) callback();
    }, delay);
    this.intervals.add(id);
    return id;
  }

  clearInterval(id) {
    if (id === null || id === undefined) return false;
    clearInterval(id);
    return this.intervals.delete(id);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.controller.abort();
    this.timeouts.forEach(clearTimeout);
    this.intervals.forEach(clearInterval);
    this.timeouts.clear();
    this.intervals.clear();
  }
}
