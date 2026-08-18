const TO_DESIGN_SYSTEM_QUALITY = Object.freeze({
  fresh: "current",
  delayed: "delayed",
  stale: "confirmed",
  unavailable: "unavailable",
});

export function toDesignSystemQuality(quality) {
  return TO_DESIGN_SYSTEM_QUALITY[quality] || "unavailable";
}
