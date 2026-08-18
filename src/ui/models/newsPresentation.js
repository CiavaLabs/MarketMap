import { formatMarketMapTime } from "../../utils/dateTime.js";

const MAX_VISIBLE_INSTRUMENTS = 3;

export function formatNewsTimestamp(value) {
  return formatMarketMapTime(value, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function sourceLabel(source) {
  if (source === "yahoo") return "Yahoo Finance";
  if (source === "finnhub") return "Finnhub";
  return null;
}

function joinNames(names) {
  if (names.length < 2) return names[0] || "news providers";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

function provenanceSources(articles, sources) {
  const normalized = [...(sources || []), ...(articles || []).map(({ provider }) => provider)]
    .filter((source) => source === "yahoo" || source === "finnhub");
  return [...new Set(normalized)].map(sourceLabel).filter(Boolean);
}

export function formatNewsSourceNames(articles, sources) {
  return joinNames(provenanceSources(articles, sources));
}

export { MAX_VISIBLE_INSTRUMENTS };
