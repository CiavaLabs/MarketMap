import { describe, expect, it } from "vitest";
import {
  BOARD_NEWS_ID,
  boardSequence,
  columnsForBoardWidth,
  moveBoardSequenceItem,
  packBoardLayout,
  visibleBoardSequence,
} from "../src/ui/models/boardLayout.js";

function readingOrder(placements) {
  return [...placements]
    .sort((a, b) => (a.row - b.row) || (a.column - b.column))
    .map(({ instrumentId }) => instrumentId);
}

function occupiedCells(placements) {
  const cells = [];
  for (const placement of placements) {
    for (let row = placement.row; row < placement.row + placement.span.rows; row += 1) {
      for (let column = placement.column; column < placement.column + placement.span.columns; column += 1) {
        cells.push(`${column}:${row}`);
      }
    }
  }
  return cells;
}

function firstAvoidableHole(placements, columns) {
  const taken = new Set(occupiedCells(placements));
  for (const placement of placements) {
    const own = new Set(occupiedCells([placement]));
    const blocked = (column, row) => taken.has(`${column}:${row}`) && !own.has(`${column}:${row}`);
    for (let row = 1; row <= placement.row; row += 1) {
      const lastAnchor = row === placement.row ? placement.column - 1 : columns;
      for (let column = 1; column <= lastAnchor && column + placement.span.columns - 1 <= columns; column += 1) {
        let free = true;
        for (let y = row; free && y < row + placement.span.rows; y += 1) {
          for (let x = column; free && x < column + placement.span.columns; x += 1) {
            if (blocked(x, y)) free = false;
          }
        }
        if (free) return { instrumentId: placement.instrumentId, column, row };
      }
    }
  }
  return null;
}

describe("board layout packer", () => {
  it("is deterministic and never overlaps at every supported column count", () => {
    const sequence = Array.from({ length: 24 }, (_, index) => `tile-${index}`);
    const tiers = new Map(sequence.map((id, index) => [
      id,
      index < 3 ? "hero" : index < 8 ? "wide" : "compact",
    ]));
    sequence.splice(5, 0, BOARD_NEWS_ID);

    for (const columns of [2, 3, 4, 5, 6]) {
      const spans = new Map([[
        BOARD_NEWS_ID,
        { columns: columns <= 3 ? columns : 2, rows: 6 },
      ]]);
      const first = packBoardLayout({ sequence, tiers, columns, spans });
      const second = packBoardLayout({ sequence, tiers, columns, spans });
      expect(second).toEqual(first);
      expect(first.map(({ instrumentId }) => instrumentId)).toEqual(sequence);
      const cells = occupiedCells(first);
      expect(new Set(cells).size).toBe(cells.length);
      expect(first.every((placement) => (
        placement.column >= 1
        && placement.column + placement.span.columns - 1 <= columns
      ))).toBe(true);
    }
  });

  it("backfills a cell a larger tile had to skip with the next tile that fits it", () => {
    const sequence = ["wide-a", "hero-a", "compact-a", "compact-b", "compact-c", "compact-d"];
    const tiers = new Map([
      ["wide-a", "wide"],
      ["hero-a", "hero"],
      ["compact-a", "compact"],
      ["compact-b", "compact"],
      ["compact-c", "compact"],
      ["compact-d", "compact"],
    ]);
    const placements = packBoardLayout({ sequence, tiers, columns: 3 });
    const byId = new Map(placements.map((placement) => [placement.instrumentId, placement]));
    expect(byId.get("wide-a")).toMatchObject({ column: 1, row: 1 });
    expect(byId.get("hero-a")).toMatchObject({ column: 1, row: 2 });
    expect(byId.get("compact-a")).toMatchObject({ column: 3, row: 1 });
    expect(firstAvoidableHole(placements, 3)).toBeNull();
    expect(readingOrder(placements)).toEqual([
      "wide-a", "compact-a", "hero-a", "compact-b", "compact-c", "compact-d",
    ]);
  });

  it("keeps tiles in authored order when every earlier region is genuinely full", () => {
    const sequence = ["compact-a", "compact-b", "compact-c", "compact-d"];
    const placements = packBoardLayout({ sequence, columns: 2 });
    expect(readingOrder(placements)).toEqual(sequence);
  });

  it("never leaves a hole any tile in the sequence could have closed, however the board is built", () => {
    let seed = 20260803;
    const next = () => {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      return seed / 4_294_967_296;
    };
    const tierNames = ["hero", "wide", "compact"];

    for (let board = 0; board < 400; board += 1) {
      const length = 4 + Math.floor(next() * 36);
      const sequence = Array.from({ length }, (_, index) => `tile-${index}`);
      const tiers = new Map(sequence.map((id) => [id, tierNames[Math.floor(next() * 3)]]));
      const columns = 2 + Math.floor(next() * 5);
      const spans = new Map();
      if (next() < 0.7) {
        sequence.splice(Math.floor(next() * (sequence.length + 1)), 0, BOARD_NEWS_ID);
        spans.set(BOARD_NEWS_ID, {
          columns: columns <= 3 ? columns : 2,
          rows: next() < 0.5 ? 6 : 2,
        });
      }

      const placements = packBoardLayout({ sequence, tiers, columns, spans });
      const cells = occupiedCells(placements);
      const where = `${columns} columns: ${sequence.map((id) => tiers.get(id) || id).join(" ")}`;
      expect(new Set(cells).size, where).toBe(cells.length);
      expect(placements.map(({ instrumentId }) => instrumentId)).toEqual(sequence);
      expect(firstAvoidableHole(placements, columns), where).toBeNull();
    }
  });

  it("packs around explicit obstacles", () => {
    const placements = packBoardLayout({
      sequence: ["a", "b", "c"],
      columns: 3,
      obstacles: [{ column: 1, row: 1, span: { columns: 2, rows: 1 } }],
    });
    expect(placements).toEqual([
      expect.objectContaining({ instrumentId: "a", column: 3, row: 1 }),
      expect.objectContaining({ instrumentId: "b", column: 1, row: 2 }),
      expect.objectContaining({ instrumentId: "c", column: 2, row: 2 }),
    ]);
  });
});

describe("board sequence operations", () => {
  it("inserts the news block at a bounded sequence position", () => {
    expect(boardSequence(["a", "b"], 1)).toEqual(["a", BOARD_NEWS_ID, "b"]);
    expect(boardSequence(["a", "b"], 99)).toEqual(["a", "b", BOARD_NEWS_ID]);
  });

  it("maps a filtered drop to the next visible neighbour without moving hidden items", () => {
    const moved = moveBoardSequenceItem({
      instrumentIds: ["a", "hidden", "b", "c"],
      newsPosition: 4,
      itemId: "c",
      beforeId: "b",
    });
    expect(moved).toEqual({
      instrumentIds: ["a", "hidden", "c", "b"],
      newsPosition: 4,
      changed: true,
    });
  });

  it("moves the news block without changing instrument order", () => {
    const moved = moveBoardSequenceItem({
      instrumentIds: ["a", "b", "c"],
      newsPosition: 0,
      itemId: BOARD_NEWS_ID,
      beforeId: "c",
    });
    expect(moved).toEqual({
      instrumentIds: ["a", "b", "c"],
      newsPosition: 2,
      changed: true,
    });
  });

  it("anchors news between the nearest visible neighbours of its full-board position", () => {
    expect(visibleBoardSequence({
      visibleInstrumentIds: ["a", "c"],
      indexById: new Map([["a", 0], ["b", 1], ["c", 2]]),
      newsPosition: 2,
    })).toEqual(["a", BOARD_NEWS_ID, "c"]);
  });

  it("matches the CSS container-query column breakpoints", () => {
    expect([960, 950, 790, 630, 420, 320].map((width) => columnsForBoardWidth(width)))
      .toEqual([6, 5, 4, 3, 2, 2]);
    expect(columnsForBoardWidth(1280, true)).toBe(1);
  });
});
