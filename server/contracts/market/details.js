import {
  DETAIL_KINDS,
  DETAIL_SECTIONS_BY_KIND,
  FIELD_AVAILABILITY_STATUSES,
  VALUE_BEARING_AVAILABILITY,
} from "./constants.js";
import { collectFieldAvailabilityIssues } from "./availability.js";
import { collectDataQualityIssues, collectSurfaceQualityIssues } from "./dataQuality.js";
import { collectInstrumentDescriptorIssues } from "./instrument.js";
import { collectProvenanceIssues } from "./provenance.js";
import { assetPolicyFor } from "../../instruments/assetPolicies.js";
import { validateMetric } from "../core/validators.js";
import {
  isObject,
  issue,
  requireEnum,
  requireObject,
  requireTimestamp,
  throwIfInvalid,
} from "./validation.js";

function collectSectionIssues(section, kind, path, issues) {
  if (!requireObject(section, path, issues)) return;
  const allowedSections = DETAIL_SECTIONS_BY_KIND[kind] || [];
  if (!allowedSections.includes(section.id)) {
    issues.push(issue(`${path}.id`, `must be one of: ${allowedSections.join(", ")} for kind ${kind}`));
  }
  requireEnum(section, "status", FIELD_AVAILABILITY_STATUSES, path, issues);

  if (!isObject(section.fields)) {
    issues.push(issue(`${path}.fields`, "must be an object"));
    return;
  }
  const fieldEntries = Object.entries(section.fields);
  const populated = fieldEntries.filter(([, value]) => value !== null && value !== undefined);
  if (VALUE_BEARING_AVAILABILITY.includes(section.status) && !populated.length) {
    issues.push(issue(`${path}.status`, "must not certify an available section without populated fields"));
  }
  if (!VALUE_BEARING_AVAILABILITY.includes(section.status) && populated.length) {
    issues.push(issue(`${path}.fields`, "must be empty when the section carries no available data"));
  }

  if (!isObject(section.fieldAvailability)) {
    if (fieldEntries.some(([, value]) => value === null || value === undefined)) {
      issues.push(issue(`${path}.fieldAvailability`, "is required to explain null fields"));
    }
    return;
  }
  for (const [field, entry] of Object.entries(section.fieldAvailability)) {
    const entryPath = `${path}.fieldAvailability.${field}`;
    if (!Object.hasOwn(section.fields, field)) {
      issues.push(issue(entryPath, "does not correspond to a section field"));
      continue;
    }
    issues.push(...collectFieldAvailabilityIssues(entry, entryPath));
    const value = section.fields[field];
    if ((value === null || value === undefined)
      && isObject(entry) && VALUE_BEARING_AVAILABILITY.includes(entry.status)) {
      issues.push(issue(`${entryPath}.status`, "must not certify a value for a null field"));
    }
  }
  for (const [field, value] of fieldEntries) {
    if ((value === null || value === undefined) && !isObject(section.fieldAvailability[field])) {
      issues.push(issue(`${path}.fieldAvailability.${field}`, "is required to explain a null field"));
    }
  }
}

export function collectInstrumentDetailsIssues(value, path = "details") {
  const issues = [];
  if (!requireObject(value, path, issues)) return issues;

  issues.push(...collectInstrumentDescriptorIssues(value.instrument, `${path}.instrument`));
  requireEnum(value, "kind", DETAIL_KINDS, path, issues);

  if (isObject(value.instrument) && DETAIL_KINDS.includes(value.kind)) {
    try {
      const policy = assetPolicyFor(value.instrument.assetClass);
      if (policy.detailKind !== value.kind) {
        issues.push(issue(`${path}.kind`, `must be ${policy.detailKind} for ${value.instrument.assetClass}`));
      }
    } catch {
    }
  }

  if (!Array.isArray(value.sections)) {
    issues.push(issue(`${path}.sections`, "must be an array"));
  } else {
    const seen = new Set();
    value.sections.forEach((section, index) => {
      const sectionPath = `${path}.sections[${index}]`;
      collectSectionIssues(section, value.kind, sectionPath, issues);
      if (isObject(section)) {
        if (seen.has(section.id)) issues.push(issue(`${sectionPath}.id`, "must be unique"));
        seen.add(section.id);
      }
    });
  }

  if (!Array.isArray(value.metrics)) {
    issues.push(issue(`${path}.metrics`, "must be an array"));
  } else {
    const seenMetrics = new Set();
    value.metrics.forEach((metric, index) => {
      try {
        validateMetric(metric, { path: `${path}.metrics[${index}]` });
      } catch (error) {
        issues.push(...(error.details?.issues || [issue(`${path}.metrics[${index}]`, error.message)]));
      }
      if (isObject(metric)) {
        if (seenMetrics.has(metric.id)) issues.push(issue(`${path}.metrics[${index}].id`, "must be unique"));
        seenMetrics.add(metric.id);
      }
    });
  }

  issues.push(...collectSurfaceQualityIssues(value, path));
  if (value.dataQuality !== undefined) {
    issues.push(...collectDataQualityIssues(value.dataQuality, `${path}.dataQuality`));
  }
  issues.push(...collectProvenanceIssues(value.provenance, `${path}.provenance`));
  requireTimestamp(value, "asOf", path, issues);
  requireTimestamp(value, "fetchedAt", path, issues);
  return issues;
}

export function validateInstrumentDetails(value, options = {}) {
  const issues = collectInstrumentDetailsIssues(value, options.path || "details");
  throwIfInvalid("InstrumentDetails", issues, options.code);
  return value;
}
