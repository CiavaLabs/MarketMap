import { dateTimeFormat } from "./intlFormats.js";

export const MARKETMAP_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function formatMarketMapTime(value, options = {}) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "—";
  const date = new Date(timestamp);
  const localOptions = { ...options };
  delete localOptions.timeZoneName;
  try {
    return dateTimeFormat("en-US", { hourCycle: "h23", ...localOptions }).format(date);
  } catch {
    return date.toLocaleString("en-US");
  }
}
