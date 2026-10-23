import { describe, expect, it } from "vite-plus/test";

import {
  WAVE_CARD_HEIGHT,
  WAVE_CARD_WIDTH,
  WAVE_COLUMN_GAP,
  WAVE_HEADER_HEIGHT,
  WAVE_ROW_GAP,
  workflowWaveLayout,
} from "./workflowWaveLayout";

const waves = [
  [{ key: "a", wave: 0, dependsOn: [] }],
  [
    { key: "b", wave: 1, dependsOn: ["a"] },
    { key: "c", wave: 1, dependsOn: ["a"] },
    { key: "d", wave: 1, dependsOn: ["a"] },
  ],
  [{ key: "e", wave: 2, dependsOn: ["a", "c"] }],
];

describe("workflowWaveLayout", () => {
  it("sizes the canvas to its widest column and tallest wave", () => {
    const layout = workflowWaveLayout(waves);
    expect(layout.width).toBe(3 * WAVE_CARD_WIDTH + 2 * WAVE_COLUMN_GAP);
    expect(layout.height).toBe(WAVE_HEADER_HEIGHT + 3 * WAVE_CARD_HEIGHT + 2 * WAVE_ROW_GAP);
    expect(layout.columns.map((column) => column.wave)).toEqual([0, 1, 2]);
  });

  it("places cards in wave columns, in plan order, without overlap and inside the canvas", () => {
    const layout = workflowWaveLayout(waves);
    const boxes = [...layout.cards.entries()];
    expect(boxes.map(([key]) => key)).toEqual(["a", "b", "c", "d", "e"]);
    expect(layout.cards.get("c")).toEqual({
      x: WAVE_CARD_WIDTH + WAVE_COLUMN_GAP,
      y: WAVE_HEADER_HEIGHT + WAVE_CARD_HEIGHT + WAVE_ROW_GAP,
      width: WAVE_CARD_WIDTH,
      height: WAVE_CARD_HEIGHT,
    });
    for (const [, box] of boxes) {
      expect(box.x + box.width).toBeLessThanOrEqual(layout.width);
      expect(box.y + box.height).toBeLessThanOrEqual(layout.height);
    }
    for (const [i, [, one]] of boxes.entries()) {
      for (const [, other] of boxes.slice(i + 1)) {
        const apart =
          one.x + one.width <= other.x ||
          other.x + other.width <= one.x ||
          one.y + one.height <= other.y ||
          other.y + other.height <= one.y;
        expect(apart).toBe(true);
      }
    }
  });

  it("is the same for the same waves, and empty for none", () => {
    expect(workflowWaveLayout(waves)).toEqual(workflowWaveLayout(waves));
    expect(workflowWaveLayout([])).toEqual({
      width: 0,
      height: 0,
      columns: [],
      cards: new Map(),
      edges: [],
    });
  });

  it("draws each dependency from its node's right edge to its dependent's left edge", () => {
    const layout = workflowWaveLayout(waves);
    expect(layout.edges.map((edge) => `${edge.from}>${edge.to}`)).toEqual([
      "a>b",
      "a>c",
      "a>d",
      "a>e",
      "c>e",
    ]);
    for (const edge of layout.edges) {
      const from = layout.cards.get(edge.from)!;
      const to = layout.cards.get(edge.to)!;
      const numbers = edge.path.match(/-?\d+(\.\d+)?/g)!.map(Number);
      expect(numbers.slice(0, 2)).toEqual([from.x + from.width, from.y + from.height / 2]);
      expect(numbers.slice(-2)).toEqual([to.x, to.y + to.height / 2]);
    }
  });

  it("skips lines to nodes it has no card for", () => {
    const layout = workflowWaveLayout([[{ key: "a", wave: 0, dependsOn: ["gone"] }]]);
    expect(layout.edges).toEqual([]);
  });

  it("routes a line that skips a wave between cards, never across one", () => {
    // a -> e skips wave 1, whose three cards sit level with a.
    const layout = workflowWaveLayout(waves);
    const skip = layout.edges.find((edge) => edge.from === "a" && edge.to === "e")!;
    const lane = Number(skip.path.match(/ L -?[\d.]+ (-?[\d.]+)/)![1]);
    for (const key of ["b", "c", "d"]) {
      const box = layout.cards.get(key)!;
      expect(lane <= box.y || lane >= box.y + box.height).toBe(true);
    }
    expect(lane).toBeLessThanOrEqual(layout.height);
  });

  it("grows a one-row canvas so a line that skips a wave can run below the cards", () => {
    const skipping = workflowWaveLayout([
      [{ key: "a", wave: 0 }],
      [{ key: "b", wave: 1, dependsOn: ["a"] }],
      [{ key: "c", wave: 2, dependsOn: ["a", "b"] }],
    ]);
    const plain = workflowWaveLayout([
      [{ key: "a", wave: 0 }],
      [{ key: "b", wave: 1, dependsOn: ["a"] }],
      [{ key: "c", wave: 2, dependsOn: ["b"] }],
    ]);
    expect(skipping.height).toBe(plain.height + WAVE_ROW_GAP);
    const skip = skipping.edges.find((edge) => edge.from === "a" && edge.to === "c")!;
    const lane = Number(skip.path.match(/ L -?[\d.]+ (-?[\d.]+)/)![1]);
    const b = skipping.cards.get("b")!;
    expect(lane).toBeGreaterThanOrEqual(b.y + b.height);
    expect(lane).toBeLessThanOrEqual(skipping.height);
  });
});
