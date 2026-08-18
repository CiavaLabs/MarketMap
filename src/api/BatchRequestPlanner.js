export const DEFAULT_BATCH_CHUNK_SIZE = 40;
export const DEFAULT_BATCH_CONCURRENCY = 2;

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}

function nonNegativeDuration(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative finite number`);
  }
  return value;
}

function abortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  if (typeof DOMException === "function") {
    return new DOMException("The operation was aborted", "AbortError");
  }
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function validateSignal(signal) {
  if (signal === undefined || signal === null) return;
  if (
    typeof signal.aborted !== "boolean"
    || typeof signal.addEventListener !== "function"
    || typeof signal.removeEventListener !== "function"
  ) {
    throw new TypeError("signal must be an AbortSignal");
  }
}

function timeoutReason(timeoutMs) {
  const error = new Error(`Batch request timed out after ${timeoutMs}ms`);
  error.name = "TimeoutError";
  error.code = "timeout";
  error.retryable = true;
  return error;
}

export class BatchRequestPlanner {
  constructor({
    chunkSize = DEFAULT_BATCH_CHUNK_SIZE,
    concurrency = DEFAULT_BATCH_CONCURRENCY,
    keyOf = (item) => item,
  } = {}) {
    this.chunkSize = positiveInteger(chunkSize, "chunkSize");
    this.concurrency = positiveInteger(concurrency, "concurrency");
    if (typeof keyOf !== "function") throw new TypeError("keyOf must be a function");
    this.keyOf = keyOf;
  }

  plan(items, options = {}) {
    if (!Array.isArray(items)) throw new TypeError("items must be an array");
    const chunkSize = positiveInteger(options.chunkSize ?? this.chunkSize, "chunkSize");
    const keyOf = options.keyOf ?? this.keyOf;
    if (typeof keyOf !== "function") throw new TypeError("keyOf must be a function");

    const seen = new Set();
    const uniqueItems = [];
    for (const item of items) {
      const key = keyOf(item);
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueItems.push(item);
    }

    const chunks = [];
    for (let index = 0; index < uniqueItems.length; index += chunkSize) {
      chunks.push(uniqueItems.slice(index, index + chunkSize));
    }
    return chunks;
  }

  async execute(items, worker, options = {}) {
    if (typeof worker !== "function") throw new TypeError("worker must be a function");
    validateSignal(options.signal);
    const concurrency = positiveInteger(options.concurrency ?? this.concurrency, "concurrency");
    const timeoutMs = options.timeoutMs == null
      ? null
      : nonNegativeDuration(options.timeoutMs, "timeoutMs");
    const chunks = this.plan(items, options);
    const externalSignal = options.signal ?? null;
    if (externalSignal?.aborted) throw abortReason(externalSignal);
    if (!chunks.length) return [];

    const batchController = new AbortController();
    const forwardAbort = () => batchController.abort(externalSignal.reason);
    externalSignal?.addEventListener("abort", forwardAbort, { once: true });
    const timeout = timeoutMs && timeoutMs > 0
      ? setTimeout(() => batchController.abort(timeoutReason(timeoutMs)), timeoutMs)
      : null;
    timeout?.unref?.();

    let rejectOnAbort;
    const aborted = new Promise((_, reject) => {
      rejectOnAbort = () => reject(abortReason(batchController.signal));
      batchController.signal.addEventListener("abort", rejectOnAbort, { once: true });
    });

    const results = new Array(chunks.length);
    let cursor = 0;
    const runWorker = async () => {
      while (!batchController.signal.aborted) {
        const chunkIndex = cursor;
        cursor += 1;
        if (chunkIndex >= chunks.length) return;
        const chunk = chunks[chunkIndex];
        try {
          const value = await worker([...chunk], {
            chunkIndex,
            signal: batchController.signal,
          });
          if (batchController.signal.aborted) throw abortReason(batchController.signal);
          results[chunkIndex] = {
            chunkIndex,
            items: chunk,
            status: "fulfilled",
            value,
          };
        } catch (reason) {
          if (batchController.signal.aborted) throw abortReason(batchController.signal);
          results[chunkIndex] = {
            chunkIndex,
            items: chunk,
            status: "rejected",
            reason,
          };
        }
      }
      throw abortReason(batchController.signal);
    };

    const work = Promise.all(
      Array.from({ length: Math.min(concurrency, chunks.length) }, runWorker),
    ).then(() => results);

    try {
      return await Promise.race([work, aborted]);
    } finally {
      if (timeout !== null) clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", forwardAbort);
      batchController.signal.removeEventListener("abort", rejectOnAbort);
    }
  }
}
