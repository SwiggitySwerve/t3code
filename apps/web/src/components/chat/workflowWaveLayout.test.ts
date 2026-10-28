import { describe, expect, it } from "vite-plus/test";

import {
  WAVE_CARD_PADDING,
  WAVE_CARD_WIDTH,
  WAVE_CHECKER_ROW_HEIGHT,
  WAVE_COLUMN_GAP,
  WAVE_HEADER_HEIGHT,
  WAVE_ROW_GAP,
  visibleWaveCards,
  WAVE_CARD_MIN_WIDTH,
  waveCardWidth,
  waveNameLines,
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
  it("sizes a card from its own text and adds checker rows only to nodes that have one", () => {
    const layout = workflowWaveLayout([
      [
        { key: "none", wave: 0 },
        { key: "one", wave: 0, checkers: [{}] },
        { key: "two", wave: 0, checkers: [{}, {}] },
        { key: "many", wave: 0, checkers: Array.from({ length: 9 }, () => ({})) },
      ],
    ]);
    const height = (key: string) => layout.cards.get(key)!.height;
    expect(layout.cards.get("none")!.checkerBand).toBe(0);
    expect(height("one")).toBe(height("none") + WAVE_CHECKER_ROW_HEIGHT);
    expect(height("two")).toBe(height("none") + 2 * WAVE_CHECKER_ROW_HEIGHT);
    // Further attempts scroll inside the two rows; the card stops growing.
    expect(height("many")).toBe(height("two"));
    expect(height("none")).toBeGreaterThan(WAVE_CARD_PADDING);
  });

  it("gives a long step name a second line and a short one a single line", () => {
    const one = workflowWaveLayout([[{ key: "a", wave: 0, label: "Count source files" }]]);
    const two = workflowWaveLayout([
      [
        {
          key: "a",
          wave: 0,
          label: "Audit every package manifest, lockfile and workspace override",
        },
      ],
    ]);
    expect(one.cards.get("a")!.nameLines).toBe(1);
    expect(two.cards.get("a")!.nameLines).toBe(2);
    expect(two.cards.get("a")!.height).toBeGreaterThan(one.cards.get("a")!.height);
  });

  it("estimates wide glyphs, unbroken words and the history button when counting name lines", () => {
    expect(waveNameLines("", false)).toBe(1);
    expect(waveNameLines("日本語のステップ名ですよろしくお願いします", false)).toBe(2);
    expect(waveNameLines("/var/lib/build/cache/workspace/generated/index.ts", false)).toBe(2);
    // A name that just fits one line wraps once the history button takes room beside it.
    expect(waveNameLines("Count documentation files now", false)).toBe(1);
    expect(waveNameLines("Count documentation files now", true)).toBe(2);
  });

  it("drops the tokens line for a node that never ran and adds a band for a failure reason", () => {
    const layout = workflowWaveLayout([
      [
        { key: "ran", wave: 0 },
        { key: "idle", wave: 0, started: false },
        { key: "short", wave: 0, failure: "docs/ was not found." },
        {
          key: "long",
          wave: 0,
          failure: "The command exited with code 1: docs/ was not found. ".repeat(4),
        },
      ],
    ]);
    const height = (key: string) => layout.cards.get(key)!.height;
    expect(layout.cards.get("idle")!.started).toBe(false);
    expect(height("idle")).toBeLessThan(height("ran"));
    expect(layout.cards.get("short")!.reasonLines).toBe(1);
    expect(layout.cards.get("long")!.reasonLines).toBe(2);
    expect(height("long")).toBeGreaterThan(height("short"));
    expect(height("short")).toBeGreaterThan(height("ran"));
  });

  it("shrinks cards on a narrow screen so two columns fit, and never below the minimum", () => {
    expect(waveCardWidth(null)).toBe(WAVE_CARD_WIDTH);
    expect(waveCardWidth(1200)).toBe(WAVE_CARD_WIDTH);
    const narrow = waveCardWidth(352);
    expect(narrow).toBeLessThan(WAVE_CARD_WIDTH);
    expect(2 * narrow + WAVE_COLUMN_GAP + 8).toBeLessThanOrEqual(352);
    expect(waveCardWidth(100)).toBe(WAVE_CARD_MIN_WIDTH);
    const layout = workflowWaveLayout([[{ key: "a", wave: 0 }], [{ key: "b", wave: 1 }]], narrow);
    expect(layout.cards.get("a")!.width).toBe(narrow);
    expect(layout.cards.get("b")!.x).toBe(narrow + WAVE_COLUMN_GAP);
    expect(layout.width).toBe(2 * narrow + WAVE_COLUMN_GAP);
    // Narrower cards wrap a name sooner.
    expect(waveNameLines("Count documentation files", false)).toBe(1);
    expect(waveNameLines("Count documentation files", false, narrow)).toBe(2);
  });

  it("fits three waves in the chat column and two on a phone", () => {
    // The scroll area of the workflow block at the normal chat width.
    const chat = 696;
    const three = waveCardWidth(chat, 3);
    expect(3 * three + 2 * WAVE_COLUMN_GAP + 8).toBeLessThanOrEqual(chat);
    expect(three).toBeGreaterThan(WAVE_CARD_MIN_WIDTH);
    // A graph of one or two waves keeps the full card.
    expect(waveCardWidth(chat, 2)).toBe(WAVE_CARD_WIDTH);
    // Too narrow for three comfortable cards: two columns share the row.
    const phone = waveCardWidth(352, 3);
    expect(2 * phone + WAVE_COLUMN_GAP + 8).toBeLessThanOrEqual(352);
  });

  it("gives the note of a node that never ran a second line when it needs one", () => {
    const layout = workflowWaveLayout([
      [
        { key: "short", wave: 0, started: false, note: "after Survey" },
        {
          key: "long",
          wave: 0,
          started: false,
          note: "Skipped because Count documentation files failed to build",
        },
      ],
    ]);
    expect(layout.cards.get("short")!.noteLines).toBe(1);
    expect(layout.cards.get("long")!.noteLines).toBe(2);
    expect(layout.cards.get("long")!.height).toBeGreaterThan(layout.cards.get("short")!.height);
  });

  it("draws the history button only where the caller asks for it", () => {
    const layout = workflowWaveLayout([
      [
        { key: "first", wave: 0 },
        { key: "retried", wave: 0, historyButton: true },
      ],
    ]);
    expect([...layout.cards.values()].map((box) => box.historyButton)).toEqual([false, true]);
  });

  it("keeps one row grid: a row is as tall as its tallest card, and lines meet each card's middle", () => {
    const layout = workflowWaveLayout([
      [
        { key: "a", wave: 0, checkers: [{}, {}] },
        { key: "b", wave: 0 },
      ],
      [
        { key: "c", wave: 1, dependsOn: ["a"] },
        { key: "d", wave: 1, dependsOn: ["b"] },
      ],
    ]);
    const [a, b, c, d] = ["a", "b", "c", "d"].map((key) => layout.cards.get(key)!);
    // Cards in one row start together; the next row starts below the taller card.
    expect(c!.y).toBe(a!.y);
    expect(d!.y).toBe(b!.y);
    expect(b!.y).toBe(a!.y + a!.height + WAVE_ROW_GAP);
    expect(c!.height).toBeLessThan(a!.height);
    expect(layout.height).toBe(b!.y + b!.height);
    const edge = layout.edges.find((entry) => entry.from === "a")!;
    const numbers = edge.path.match(/-?\d+(\.\d+)?/g)!.map(Number);
    expect(numbers.slice(0, 2)).toEqual([a!.x + a!.width, a!.y + a!.height / 2]);
    expect(numbers.slice(-2)).toEqual([c!.x, c!.y + c!.height / 2]);
  });

  it("sizes the canvas to its widest column and tallest wave", () => {
    const layout = workflowWaveLayout(waves);
    expect(layout.width).toBe(3 * WAVE_CARD_WIDTH + 2 * WAVE_COLUMN_GAP);
    const card = layout.cards.get("a")!.height;
    expect(layout.height).toBe(WAVE_HEADER_HEIGHT + 3 * card + 2 * WAVE_ROW_GAP);
    expect(layout.columns.map((column) => column.wave)).toEqual([0, 1, 2]);
  });

  it("places cards in wave columns, in plan order, without overlap and inside the canvas", () => {
    const layout = workflowWaveLayout(waves);
    const boxes = [...layout.cards.entries()];
    expect(boxes.map(([key]) => key)).toEqual(["a", "b", "c", "d", "e"]);
    const card = layout.cards.get("a")!.height;
    expect(layout.cards.get("c")).toMatchObject({
      x: WAVE_CARD_WIDTH + WAVE_COLUMN_GAP,
      y: WAVE_HEADER_HEIGHT + card + WAVE_ROW_GAP,
      width: WAVE_CARD_WIDTH,
      height: card,
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

  it("draws in full only the cards inside the viewport and its margin", () => {
    const grid = workflowWaveLayout(
      Array.from({ length: 10 }, (_, wave) =>
        Array.from({ length: 10 }, (_, row) => ({ key: `n${wave}-${row}`, wave })),
      ),
    );
    const viewport = { left: 0, top: 0, width: 736, height: 480 };
    const drawn = visibleWaveCards(grid, viewport, 0);
    for (const [key, box] of grid.cards) {
      const inside =
        box.x < viewport.width &&
        box.x + box.width > 0 &&
        box.y < viewport.height &&
        box.y + box.height > 0;
      expect(drawn.has(key)).toBe(inside);
    }
    expect(drawn.size).toBeGreaterThan(0);
    expect(drawn.size).toBeLessThan(grid.cards.size / 4);
    // The margin draws the next column and row before they scroll in.
    const widened = visibleWaveCards(grid, viewport);
    expect(widened.size).toBeGreaterThan(drawn.size);
    for (const key of drawn) expect(widened.has(key)).toBe(true);
    // Scrolled to the far corner, only the far cards remain.
    const far = visibleWaveCards(
      grid,
      { left: grid.width - 736, top: grid.height - 480, width: 736, height: 480 },
      0,
    );
    expect(far.has("n9-9")).toBe(true);
    expect(far.has("n0-0")).toBe(false);
  });
});
