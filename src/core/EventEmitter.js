export class EventEmitter {
  constructor() {
    this._events = new Map();
  }

  on(event, handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('Handler must be a function');
    }

    if (!this._events.has(event)) {
      this._events.set(event, []);
    }

    const handlers = this._events.get(event);
    handlers.push(handler);

    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      this.off(event, handler);
    };
  }

  once(event, handler) {
    const off = this.on(event, (...args) => {
      off();
      handler(...args);
    });
    return off;
  }

  off(event, handler) {
    if (!this._events.has(event)) return;

    const handlers = this._events.get(event);
    const index = handlers.indexOf(handler);

    if (index !== -1) {
      handlers.splice(index, 1);
    }

    if (handlers.length === 0) {
      this._events.delete(event);
    }
  }

  emit(event, data) {
    if (!this._events.has(event)) return;

    const handlers = this._events.get(event);

    [...handlers].forEach(handler => {
      try {
        handler(data);
      } catch (error) {
        console.error(`Error in event handler for "${event}":`, error);
      }
    });
  }

  removeAllListeners(event) {
    if (event) {
      this._events.delete(event);
    } else {
      this._events.clear();
    }
  }

  listenerCount(event) {
    return this._events.has(event) ? this._events.get(event).length : 0;
  }
}
