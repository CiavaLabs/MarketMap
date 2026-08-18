import { readFile } from "node:fs/promises";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

const loadCss = async (name) => postcss.parse(
  await readFile(new URL(`../css/${name}`, import.meta.url), "utf8"),
  { from: name },
);

const [base, tiles, tokens] = await Promise.all([
  loadCss("base.css"),
  loadCss("tiles.css"),
  loadCss("tokens.css"),
]);

function enclosingAtRule(node, name) {
  let parent = node.parent;
  while (parent) {
    if (parent.type === "atrule" && parent.name === name) return parent;
    parent = parent.parent;
  }
  return null;
}

function findRule(root, selector, container = null, media = null) {
  let match = null;
  root.walkRules((rule) => {
    if (match || !(rule.selectors || []).includes(selector)) return;
    const query = enclosingAtRule(rule, "container");
    const mediaQuery = enclosingAtRule(rule, "media");
    if ((query?.params || null) === container && (mediaQuery?.params || null) === media) match = rule;
  });
  return match;
}

function valueOf(rule, property) {
  let value = null;
  rule?.walkDecls(property, (declaration) => { value = declaration.value; });
  return value;
}

describe("tile visual contract", () => {
  it("uses an explicitly packed grid with six tracks on wide boards and responsive density steps", () => {
    const selector = ".marketmap-app .marketmap-grid";
    const base = findRule(tiles, selector);
    expect(valueOf(base, "grid-template-columns")).toBe("repeat(6, minmax(0, 1fr))");
    expect(valueOf(base, "grid-auto-flow")).toBe("row");

    for (const [width, columns] of [[950, 5], [790, 4], [630, 3], [420, 2]]) {
      const rule = findRule(tiles, selector, `marketmap (max-width: ${width}px)`);
      expect(valueOf(rule, "grid-template-columns"))
        .toBe(`repeat(${columns}, minmax(0, 1fr))`);
    }
  });

  it("leaves tier and news coordinates to the explicit layout model", () => {
    expect(findRule(tiles, '.marketmap-app .asset-tile[data-tier="hero"]')).toBeNull();
    expect(valueOf(findRule(tiles, ".marketmap-app .mm-layout-cell"), "display")).toBe("grid");
    const news = findRule(tiles, '.marketmap-app [data-cell="news"]');
    expect(valueOf(news, "grid-column")).toBeNull();
    expect(valueOf(news, "grid-row")).toBeNull();
    expect(valueOf(news, "align-self")).toBe("start");
    expect(valueOf(news, "max-block-size")).toBe("none");
    expect(valueOf(news, "overflow")).toBe("visible");
  });

  it("keeps geometry semantic and slightly rounded across component classes", () => {
    const rootTokens = findRule(tokens, ".marketmap-app");
    expect(valueOf(rootTokens, "--mm-radius-sm")).toBe("5px");
    expect(valueOf(rootTokens, "--mm-radius-md")).toBe("8px");
    expect(valueOf(rootTokens, "--mm-radius-lg")).toBe("12px");
    expect(findRule(tiles, ".marketmap-app .add-tile")).toBeNull();
  });

  it("does not paint a square-grid texture behind the page", () => {
    expect(findRule(base, ".marketmap-app::before")).toBeNull();
  });

  it("keeps the page ambience scroll-responsive without giving the footer a separate surface", () => {
    const ambient = findRule(
      base,
      ".marketmap-app",
      null,
      "(min-width: 48rem) and (prefers-reduced-motion: no-preference)",
    );
    const footer = findRule(base, ".marketmap-app .page-footer");

    expect(valueOf(ambient, "background-attachment")).toBe("fixed");
    expect(valueOf(footer, "background")).toBeNull();
    expect(valueOf(footer, "border-top")).toBeNull();
  });
});
