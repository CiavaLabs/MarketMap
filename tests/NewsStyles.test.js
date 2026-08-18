import { readFile } from "node:fs/promises";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

const newsPath = new URL("../css/news.css", import.meta.url);
const entryPath = new URL("../css/marketmap.css", import.meta.url);
const news = postcss.parse(await readFile(newsPath, "utf8"), { from: newsPath.pathname });
const entry = postcss.parse(await readFile(entryPath, "utf8"), { from: entryPath.pathname });

function enclosingAtRule(node, name) {
  let parent = node.parent;
  while (parent) {
    if (parent.type === "atrule" && parent.name === name) return parent;
    parent = parent.parent;
  }
  return null;
}

function findRule(root, selector, container = null) {
  let match = null;
  root.walkRules((rule) => {
    if (match || !(rule.selectors || []).includes(selector)) return;
    const query = enclosingAtRule(rule, "container");
    if ((query?.params || null) === container) match = rule;
  });
  return match;
}

function valueOf(rule, property) {
  let value = null;
  rule?.walkDecls(property, (declaration) => { value = declaration.value; });
  return value;
}

describe("news CSS architecture", () => {
  it("imports the single news owner after details", () => {
    const imports = [];
    entry.walkAtRules("import", (rule) => imports.push(rule.params.replaceAll('"', "")));
    const newsIndex = imports.indexOf("./news.css");

    expect(newsIndex).toBeGreaterThan(-1);
    expect(imports[newsIndex - 1]).toBe("./details.css");
    expect(imports[newsIndex + 1]).toBe("./states.css");
    expect(imports.filter((value) => value === "./news.css")).toHaveLength(1);
  });

  it("styles only the cell chrome the board emits, leaving the feed itself to the design system", () => {
    const collapsedTitle = findRule(news, ".marketmap-app .mm-news-cell--collapsed .mm-news__title");
    const retryFocus = findRule(news, ".marketmap-app .mm-news__retry:focus-visible");

    expect(collapsedTitle).not.toBeNull();
    expect(valueOf(retryFocus, "outline")).toBe("2px solid var(--mm-focus)");

    const selectors = [];
    news.walkRules((rule) => selectors.push(...(rule.selectors || [])));
    const emitted = new Set([
      "mm-news",
      "mm-news-cell",
      "mm-news-cell--collapsed",
      "mm-news-cell__controls",
      "mm-news-cell__grip",
      "mm-news-cell__summary",
      "mm-news-cell__toggle",
      "mm-news__retry",
      "mm-news__title",
    ]);
    const orphans = [...new Set(selectors.flatMap((selector) => selector.match(/mm-news[\w-]*/g) || []))]
      .filter((name) => !emitted.has(name));
    expect(orphans).toEqual([]);

    const truncationProperties = [];
    news.walkDecls(/^(?:-webkit-)?line-clamp$/, (declaration) => {
      truncationProperties.push(declaration.prop);
    });
    expect(truncationProperties).toEqual([]);
  });
});
