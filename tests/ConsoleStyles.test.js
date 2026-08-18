import { readFile } from "node:fs/promises";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

const consolePath = new URL("../css/console.css", import.meta.url);
const pulsePath = new URL("../css/pulse.css", import.meta.url);

const consoleCss = postcss.parse(await readFile(consolePath, "utf8"), { from: consolePath.pathname });
const pulseCss = postcss.parse(await readFile(pulsePath, "utf8"), { from: pulsePath.pathname });

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

describe("console and pulse CSS architecture", () => {
  it("lays the toolbar out as a flat hairline band hosting the control island", () => {
    const toolbar = findRule(consoleCss, ".marketmap-app .mm-toolbar");
    expect(valueOf(toolbar, "display")).toBe("flex");
    expect(valueOf(toolbar, "flex-wrap")).toBe("wrap");
    expect(valueOf(toolbar, "border-bottom")).toBe("1px solid var(--mm-line)");
    expect(valueOf(toolbar, "background")).toBeNull();
    expect(valueOf(toolbar, "border-radius")).toBeNull();
    expect(valueOf(toolbar, "backdrop-filter")).toBeNull();

    const island = findRule(consoleCss, ".marketmap-app .mm-toolbar__island");
    expect(valueOf(island, "display")).toBe("grid");
    expect(valueOf(island, "grid-template-columns")).toBe("repeat(auto-fit, minmax(8rem, 1fr))");
    const meta = findRule(consoleCss, ".marketmap-app .mm-toolbar__meta");
    expect(valueOf(meta, "margin-left")).toBe("auto");
    expect(valueOf(meta, "align-self")).toBe("start");
  });

  it("lays the masthead as a flex row: identity left, live status right", () => {
    const masthead = findRule(consoleCss, ".marketmap-app .mm-masthead");
    expect(valueOf(masthead, "display")).toBe("flex");
    expect(valueOf(masthead, "justify-content")).toBe("space-between");
    const identity = findRule(consoleCss, ".marketmap-app .mm-masthead__identity");
    expect(valueOf(identity, "display")).toBe("flex");
    expect(valueOf(findRule(consoleCss, ".marketmap-app .mm-masthead__title"), "font-family"))
      .toBe("var(--mm-font-sans)");
    expect(valueOf(findRule(consoleCss, ".marketmap-app .mm-masthead__title"), "font-size"))
      .toBe("clamp(2.625rem, 5.15cqi, 3.375rem)");
    expect(findRule(consoleCss, ".marketmap-app .mm-masthead__subtitle")).toBeNull();
    const status = findRule(consoleCss, ".marketmap-app .mm-status");
    expect(valueOf(status, "border-radius")).toBe("var(--mm-radius-control)");
  });

  it("keeps end-aligned popovers anchored to positioned wrappers inside the container gutter", () => {
    const anchor = findRule(consoleCss, ".marketmap-app .mm-popover-anchor");
    const popover = findRule(consoleCss, ".marketmap-app .mm-popover");
    const statusRule = findRule(consoleCss, ".marketmap-app .mm-status");
    const meta = findRule(consoleCss, ".marketmap-app .mm-toolbar__meta");

    expect(valueOf(anchor, "position")).toBeNull();
    expect(valueOf(statusRule, "position")).toBe("relative");
    expect(valueOf(meta, "position")).toBe("relative");
    expect(valueOf(popover, "inset-inline-end")).toBe("0");
    expect(valueOf(popover, "width")).toBe("min(21rem, calc(100cqi - var(--mm-space-6)))");
    expect(valueOf(findRule(consoleCss, ".marketmap-app .mm-toolbar:has(.mm-popover:not([hidden]))"), "z-index"))
      .toBe("var(--mm-z-overlay)");
    expect(findRule(consoleCss, '.marketmap-app [role="listbox"]')).toBeNull();
  });

  it("lays the pulse out as one hairline-ruled strip with an aligned action group at the end", () => {
    const band = findRule(pulseCss, ".marketmap-app .mm-pulse-band");
    expect(valueOf(band, "display")).toBe("flex");
    expect(valueOf(band, "border-bottom")).toBe("1px solid var(--mm-line)");
    const pulse = findRule(pulseCss, ".marketmap-app .mm-pulse");
    expect(valueOf(pulse, "display")).toBe("flex");
    const stat = findRule(pulseCss, ".marketmap-app .mm-stat");
    expect(valueOf(stat, "border-inline-start")).toBe("1px solid var(--mm-line)");
    expect(valueOf(stat, "grid-template-rows")).toBe("auto auto 3px");
    expect(valueOf(stat, "align-content")).toBe("start");
    expect(valueOf(findRule(pulseCss, ".marketmap-app .mm-stat:first-child"), "border-inline-start"))
      .toBe("0");

    expect(findRule(pulseCss, ".marketmap-app .mm-add")).toBeNull();
    const actions = findRule(consoleCss, ".marketmap-app .mm-actions");
    expect(valueOf(actions, "margin-inline-start")).toBe("auto");

    const leading = findRule(pulseCss, ".marketmap-app .mm-stat__value--leading");
    expect(valueOf(leading, "white-space")).toBe("normal");
    expect(valueOf(leading, "overflow")).toBe("visible");
  });

  it("uses container queries only for feature responsiveness", () => {
    const mediaRules = [];
    consoleCss.walkAtRules("media", (rule) => mediaRules.push(rule.params));
    pulseCss.walkAtRules("media", (rule) => mediaRules.push(rule.params));
    expect(mediaRules).toEqual([]);
  });
});
