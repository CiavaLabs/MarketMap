const SECRET_KEYS = /(?:token|secret|api[-_]?key|authorization)/i;
const SECRET_QUERY_VALUE = /([?&](?:token|secret|api[-_]?key|authorization)=)[^&#\s]*/gi;
const BEARER_VALUE = /(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi;

function redactString(value) {
  return value
    .replace(SECRET_QUERY_VALUE, "$1[REDACTED]")
    .replace(BEARER_VALUE, "$1[REDACTED]");
}

function redact(value, seen = new WeakSet()) {
  if (typeof value === "string") return redactString(value);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SECRET_KEYS.test(key) ? "[REDACTED]" : redact(item, seen),
  ]));
}

export function createStructuredLogger({ sink = console, context = {}, enabled = true } = {}) {
  const write = (level, payload, message) => {
    if (!enabled) return;
    const entry = redact({
      timestamp: new Date().toISOString(),
      level,
      ...context,
      ...(typeof payload === "object" && payload !== null ? payload : { message: payload }),
      ...(message ? { message } : {}),
    });
    const method = level === "error" ? "error" : level === "warn" ? "warn" : "log";
    sink[method]?.(JSON.stringify(entry));
  };
  return Object.freeze({
    debug: (payload, message) => write("debug", payload, message),
    info: (payload, message) => write("info", payload, message),
    warn: (payload, message) => write("warn", payload, message),
    error: (payload, message) => write("error", payload, message),
    child(extra) {
      return createStructuredLogger({ sink, enabled, context: { ...context, ...extra } });
    },
  });
}
