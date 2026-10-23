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
  [{ key: "a", wave: 0 }],
  [
    { key: "b", wave: 1 },
    { key: "c", wave: 1 },
    { key: "d", wave: 1 },
  ],
  [{ key: "e", wave: 2 }],
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
    expect(workflowWaveLayout([])).toEqual({ width: 0, height: 0, columns: [], cards: new Map() });
  });
});
