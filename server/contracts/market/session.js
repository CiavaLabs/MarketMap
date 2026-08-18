import {
  SESSION_MODELS,
  SESSION_PHASES_BY_MODEL,
} from "./constants.js";
import {
  isNonEmptyString,
  issue,
  requireEnum,
  requireNullableTimestamp,
  requireObject,
} from "./validation.js";

const TIMEZONE_PATTERN = /^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)$/;

export function collectSessionIssues(session, path, { requirePhase = true } = {}) {
  const issues = [];
  if (!requireObject(session, path, issues)) return issues;
  requireEnum(session, "model", SESSION_MODELS, path, issues);

  if (requirePhase) {
    const phases = SESSION_PHASES_BY_MODEL[session.model];
    if (phases && !phases.includes(session.phase)) {
      issues.push(issue(`${path}.phase`, `must be one of: ${phases.join(", ")} for a ${session.model} session`));
    }
    if (session.isTrading !== null && typeof session.isTrading !== "boolean") {
      issues.push(issue(`${path}.isTrading`, "must be a boolean or null"));
    }
    for (const key of ["regularStart", "regularEnd"]) {
      if (Object.hasOwn(session, key)) requireNullableTimestamp(session, key, path, issues);
    }
  }

  if (session.timezone !== null
    && (!isNonEmptyString(session.timezone) || !TIMEZONE_PATTERN.test(session.timezone))) {
    issues.push(issue(`${path}.timezone`, "must be an IANA timezone, UTC, or null"));
  }
  return issues;
}
