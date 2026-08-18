export class SingleFlight {
  constructor() {
    this.operations = new Map();
  }

  get size() {
    return this.operations.size;
  }

  has(key) {
    return this.operations.has(key);
  }

  keys() {
    return [...this.operations.keys()];
  }

  run(key, operation) {
    if (typeof key !== "string" || key.length === 0) {
      throw new TypeError("Single-flight key must be a non-empty string");
    }
    if (typeof operation !== "function") {
      throw new TypeError("Single-flight operation must be a function");
    }

    const active = this.operations.get(key);
    if (active) return active;

    const promise = Promise.resolve().then(operation);
    this.operations.set(key, promise);
    const remove = () => {
      if (this.operations.get(key) === promise) this.operations.delete(key);
    };
    promise.then(remove, remove);
    return promise;
  }
}
