import { readFile } from "node:fs/promises";
import postcss from "postcss";

const MINIMUM_TEXT_CONTRAST = 4.5;
const MINIMUM_GRAPHIC_CONTRAST = 3;
const THEME_TEXT_PAIRS = [
  ...["--mm-bg", "--mm-surface", "--mm-surface-raised"]
    .flatMap((background) => [
      ["--mm-ink", background],
      ["--mm-ink-soft", background],
      ["--mm-muted", background],
    ]),
];
const THEME_GRAPHIC_PAIRS = [
  ...["--mm-bg", "--mm-surface", "--mm-surface-raised"]
    .flatMap((background) => [
      ["--mm-accent", background],
      ["--mm-gain", background],
      ["--mm-loss", background],
    ]),
];

function contextFor(selector) {
  const normalized = String(selector || "").trim().replace(/\s+/g, " ");
  if (normalized === ".marketmap-app") return "base";
  if (normalized === ".marketmap-app:not([data-marketmap-theme])") return "light";
  if (/data-marketmap-theme=["']light["']/.test(normalized) && !normalized.includes(":not(")) return "light";
  if (/data-marketmap-theme=["']dark["']/.test(normalized) || normalized.includes(":not(")) return "dark";
  return null;
}

function parseColour(value, label) {
  const input = String(value || "").trim();
  const hex = input.match(/^#([\da-f]{3}|[\da-f]{6})$/i);
  if (hex) {
    const digits = hex[1].length === 3
      ? [...hex[1]].map((digit) => `${digit}${digit}`).join("")
      : hex[1];
    return [0, 2, 4].map((offset) => Number.parseInt(digits.slice(offset, offset + 2), 16));
  }

  const rgb = input.match(/^rgb\(\s*(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s*\)$/i);
  if (rgb) return rgb.slice(1).map(Number);
  throw new Error(`${label} must be an opaque solid hex/rgb colour for deterministic contrast checks; found ${input || "(empty)"}`);
}

function luminance(rgb) {
  return rgb
    .map((channel) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    })
    .reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
}

function contrast(foreground, background) {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const root = postcss.parse(await readFile("css/tokens.css", "utf8"), { from: "css/tokens.css" });
const definitions = { base: new Map(), dark: new Map(), light: new Map() };
root.walkRules((rule) => {
  const context = contextFor(rule.selector);
  if (!context) return;
  rule.walkDecls(/^--mm-/, (decl) => definitions[context].set(decl.prop, decl.value));
});

const failures = [];
let minimumText = { ratio: Number.POSITIVE_INFINITY, pair: "" };
let minimumGraphic = { ratio: Number.POSITIVE_INFINITY, pair: "" };
for (const theme of ["dark", "light"]) {
  const valueFor = (token) => definitions[theme].get(token) ?? definitions.base.get(token);
  const checkPair = (foregroundToken, backgroundToken, minimum, kind) => {
    let ratio;
    try {
      ratio = contrast(
        parseColour(valueFor(foregroundToken), `${theme} ${foregroundToken}`),
        parseColour(valueFor(backgroundToken), `${theme} ${backgroundToken}`),
      );
    } catch (error) {
      failures.push(error.message);
      return;
    }
    const pair = `${theme} ${foregroundToken} on ${backgroundToken}`;
    if (kind === "text" && ratio < minimumText.ratio) minimumText = { ratio, pair };
    if (kind === "graphic" && ratio < minimumGraphic.ratio) minimumGraphic = { ratio, pair };
    if (ratio + Number.EPSILON < minimum) {
      failures.push(`${pair}: ${ratio.toFixed(2)}:1 (needs ${minimum}:1)`);
    }
  };

  THEME_TEXT_PAIRS.forEach(([foreground, background]) => {
    checkPair(foreground, background, MINIMUM_TEXT_CONTRAST, "text");
  });
  THEME_GRAPHIC_PAIRS.forEach(([foreground, background]) => {
    checkPair(foreground, background, MINIMUM_GRAPHIC_CONTRAST, "graphic");
  });
}

if (failures.length) {
  console.error(`Theme and chart contrast failed (${failures.length}):\n  ${[...new Set(failures)].join("\n  ")}`);
  process.exitCode = 1;
} else {
  console.log(
    `Theme and chart contrast passed; text minimum ${minimumText.ratio.toFixed(2)}:1 (${minimumText.pair}); `
    + `graphic minimum ${minimumGraphic.ratio.toFixed(2)}:1 (${minimumGraphic.pair}).`,
  );
}
