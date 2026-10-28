/**
 * Where each card of a graph workflow sits: one column per wave, cards in plan order, each as
 * tall as its text needs. Every column shares one row grid, so the free strips between rows run
 * across the whole canvas; the canvas gets an explicit size for the chat list to measure.
 */
export const WAVE_CARD_WIDTH = 216;
/** On a narrow screen cards shrink, down to this width, so two columns fit side by side. */
export const WAVE_CARD_MIN_WIDTH = 152;
/** Three columns share the row only while each card keeps at least this width. */
const WAVE_CARD_COMFORT_WIDTH = 184;
/** The scroll area's side padding. */
const CANVAS_PADDING = 8;
/** Space above and below a card's text. */
export const WAVE_CARD_PADDING = 12;
/** The card's 1px border, top and bottom. */
export const WAVE_CARD_BORDER = 2;
const STATUS_LINE_HEIGHT = 14;
const NAME_LINE_HEIGHT = 16;
/** The agent line and the tokens-and-time line. */
const DETAIL_LINE_HEIGHT = 14;
/** A failed node's reason, shown in full below the card's text: two lines of text and room under them. */
const REASON_LINE_HEIGHT = 14;
const REASON_BAND_PADDING = 6;
/** One checker row; a node shows at most two, and further attempts scroll inside them. */
export const WAVE_CHECKER_ROW_HEIGHT = 28;
export const WAVE_CHECKER_ROWS_VISIBLE = 2;
export const WAVE_COLUMN_GAP = 24;
/** Wide enough for a line that skips a wave to run between two cards. */
export const WAVE_ROW_GAP = 12;
export const WAVE_HEADER_HEIGHT = 22;

/** Card width not available to text: borders, padding and a little slack. */
const NAME_INSET = 28;
const SPAN_INSET = NAME_INSET;
/** 11px text is narrower than the 12px name by this factor. */
const SMALL_TEXT_SCALE = 11 / 12;
const HISTORY_BUTTON_WIDTH = 24;
// Estimated advance of a 12px medium glyph. Deliberately wide, so a name judged to fit one line
// never wraps; a name judged to need two may occasionally leave a spare line of height.
const GLYPH_WIDTH = 6.2;
const SPACE_WIDTH = 3.4;
const CAPITAL_WIDTH = 7.6;
const WIDE_GLYPH_WIDTH = 12.5;
const WIDE_GLYPH = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠\u{1f300}-\u{1faff}]/u;

function glyphWidth(glyph: string): number {
  if (WIDE_GLYPH.test(glyph)) return WIDE_GLYPH_WIDTH;
  return glyph !== glyph.toLowerCase() ? CAPITAL_WIDTH : GLYPH_WIDTH;
}

/** Lines `text` takes in `capacity` pixels at `scale` times the 12px name, capped at two. */

const textWidth = (text: string) => [...text].reduce((sum, glyph) => sum + glyphWidth(glyph), 0);

function wrapLines(text: string, capacity: number, scale: number): 1 | 2 {
  let lines = 1;
  let used = 0;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const width = textWidth(word) * scale;
    const space = used === 0 ? 0 : SPACE_WIDTH * scale;
    if (used + space + width <= capacity) {
      used += space + width;
      continue;
    }
    // A word longer than a line breaks mid-word, as the card's overflow-wrap does.
    if (used > 0) lines += 1;
    used = width;
    while (used > capacity) {
      lines += 1;
      used -= capacity;
    }
  }
  return lines > 1 ? 2 : 1;
}

/** How many of the two allowed lines a step name needs; the card clamps the name to that many. */
export function waveNameLines(
  label: string,
  historyButton: boolean,
  cardWidth = WAVE_CARD_WIDTH,
): 1 | 2 {
  return wrapLines(label, cardWidth - NAME_INSET - (historyButton ? HISTORY_BUTTON_WIDTH : 0), 1);
}

/**
 * The card width for a scroll area `areaWidth` wide holding `waveCount` waves: up to three
 * columns share the row at full size or a little less, and a screen too narrow for that shows two.
 */
export function waveCardWidth(areaWidth: number | null | undefined, waveCount = 3): number {
  if (areaWidth === null || areaWidth === undefined || areaWidth <= 0) return WAVE_CARD_WIDTH;
  const room = areaWidth - CANVAS_PADDING;
  const fit = (columns: number) => Math.floor((room - (columns - 1) * WAVE_COLUMN_GAP) / columns);
  const columns = Math.min(Math.max(waveCount, 1), 3);
  const width = columns === 3 && fit(3) < WAVE_CARD_COMFORT_WIDTH ? fit(2) : fit(columns);
  return Math.min(WAVE_CARD_WIDTH, Math.max(WAVE_CARD_MIN_WIDTH, width));
}

/** What a node's own data decides about its card; the card draws exactly this. */
export interface WaveNodeInput {
  readonly key: string;
  readonly wave: number;
  readonly label?: string;
  readonly dependsOn?: ReadonlyArray<string>;
  readonly checkers?: ReadonlyArray<unknown>;
  /** False once known that the node never ran; its card then has no tokens-and-time line. */
  readonly started?: boolean;
  /** Why a failed node failed; the card shows it in full under its text. */
  readonly failure?: string | null;
  /** What holds back a node that never ran (its reason, or what it runs after). */
  readonly note?: string | null;
  /** The node ran more than once, so its card has a history button. */
  readonly historyButton?: boolean;
}

export interface WaveBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Lines the step name takes; the card clamps the name to them. */
  readonly nameLines: 1 | 2;
  /** The history button shows beside the text once a node ran more than once. */
  readonly historyButton: boolean;
  /** Height of the checker rows at the bottom of the card; zero for a node without a checker. */
  readonly checkerBand: number;
  /** Whether the node ran; a node that never did has no tokens-and-time line. */
  readonly started: boolean;
  /** Lines of failure reason under the card's text; zero when the node did not fail with one. */
  readonly reasonLines: 0 | 1 | 2;
  /** Lines the note of a node that never ran takes. */
  readonly noteLines: 1 | 2;
}

/** A dependency line, from the right edge of the node depended on to the left edge of its dependent. */
export interface WaveEdge {
  readonly from: string;
  readonly to: string;
  readonly path: string;
}

export interface WaveLayout {
  readonly width: number;
  readonly height: number;
  readonly columns: ReadonlyArray<{ readonly wave: number; readonly x: number }>;
  readonly cards: ReadonlyMap<string, WaveBox>;
  readonly edges: ReadonlyArray<WaveEdge>;
}

function nodeBox(node: WaveNodeInput, cardWidth: number): Omit<WaveBox, "x" | "y"> {
  const historyButton = node.historyButton === true;
  const nameLines = waveNameLines(node.label ?? "", historyButton, cardWidth);
  const checkerBand =
    Math.min(node.checkers?.length ?? 0, WAVE_CHECKER_ROWS_VISIBLE) * WAVE_CHECKER_ROW_HEIGHT;
  const started = node.started !== false;
  const reasonLines = node.failure
    ? wrapLines(node.failure, cardWidth - SPAN_INSET, SMALL_TEXT_SCALE)
    : 0;
  const noteLines =
    started || !node.note ? 1 : wrapLines(node.note, cardWidth - NAME_INSET, SMALL_TEXT_SCALE);
  return {
    width: cardWidth,
    height:
      WAVE_CARD_BORDER +
      WAVE_CARD_PADDING +
      STATUS_LINE_HEIGHT +
      nameLines * NAME_LINE_HEIGHT +
      (started ? 2 : noteLines) * DETAIL_LINE_HEIGHT +
      (reasonLines === 0 ? 0 : reasonLines * REASON_LINE_HEIGHT + REASON_BAND_PADDING) +
      checkerBand,
    nameLines,
    historyButton,
    checkerBand,
    started,
    reasonLines,
    noteLines,
  };
}

export function workflowWaveLayout(
  waves: ReadonlyArray<ReadonlyArray<WaveNodeInput>>,
  cardWidth: number = WAVE_CARD_WIDTH,
): WaveLayout {
  const sizes = waves.map((nodes) => nodes.map((node) => nodeBox(node, cardWidth)));
  // A row is as tall as its tallest card in any column.
  const rows = Math.max(0, ...waves.map((nodes) => nodes.length));
  const rowHeights = Array.from({ length: rows }, (_, row) =>
    Math.max(0, ...sizes.map((column) => column[row]?.height ?? 0)),
  );
  // rowTops[row] is where a row starts; the entry after the last row is the strip below it.
  const rowTops: Array<number> = [];
  let top = WAVE_HEADER_HEIGHT;
  for (const height of rowHeights) {
    rowTops.push(top);
    top += height + WAVE_ROW_GAP;
  }
  rowTops.push(top);
  const cards = new Map<string, WaveBox>();
  const columns = waves.map((nodes, column) => {
    const x = column * (cardWidth + WAVE_COLUMN_GAP);
    nodes.forEach((node, row) => {
      cards.set(node.key, { x, y: rowTops[row] ?? 0, ...sizes[column]![row]! });
    });
    return { wave: nodes[0]?.wave ?? column, x };
  });
  // Every column shares one row grid, so the gaps between rows (and the strip below the last
  // row) are free in every column; a line that skips a wave runs along one of them.
  const laneY = (row: number) => rowTops[row]! - WAVE_ROW_GAP / 2;
  let usesBottomLane = false;
  const edges: Array<WaveEdge> = [];
  for (const node of waves.flat()) {
    const to = cards.get(node.key);
    for (const dep of node.dependsOn ?? []) {
      const from = cards.get(dep);
      if (from === undefined || to === undefined) continue;
      const x1 = from.x + from.width;
      const y1 = from.y + from.height / 2;
      const x2 = to.x;
      const y2 = to.y + to.height / 2;
      if (x2 - x1 <= WAVE_COLUMN_GAP) {
        const bend = (x2 - x1) / 2;
        edges.push({
          from: dep,
          to: node.key,
          path: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
        });
        continue;
      }
      // Bend into the lane inside the gap after the source column, run along it past the
      // cards in between, and bend out inside the gap before the target column.
      const middle = (y1 + y2) / 2;
      let lane = 1;
      for (let row = 2; row <= rows; row += 1) {
        if (Math.abs(laneY(row) - middle) < Math.abs(laneY(lane) - middle)) lane = row;
      }
      if (lane === rows) usesBottomLane = true;
      const y = laneY(lane);
      const half = WAVE_COLUMN_GAP / 2;
      edges.push({
        from: dep,
        to: node.key,
        path: `M ${x1} ${y1} C ${x1 + half} ${y1}, ${x1 + half} ${y}, ${x1 + WAVE_COLUMN_GAP} ${y} L ${x2 - WAVE_COLUMN_GAP} ${y} C ${x2 - half} ${y}, ${x2 - half} ${y2}, ${x2} ${y2}`,
      });
    }
  }
  return {
    width: waves.length === 0 ? 0 : waves.length * cardWidth + (waves.length - 1) * WAVE_COLUMN_GAP,
    height:
      rows === 0
        ? 0
        : WAVE_HEADER_HEIGHT +
          rowHeights.reduce((sum, height) => sum + height, 0) +
          (rows - 1) * WAVE_ROW_GAP +
          (usesBottomLane ? WAVE_ROW_GAP : 0),
    columns,
    cards,
    edges,
  };
}

/** The part of the canvas the scroll area shows, in canvas coordinates. */
export interface WaveViewport {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The cards to draw in full: those inside the viewport, widened by `margin` on every side so a
 * short scroll finds them already drawn. The rest stay as light placeholders.
 */
export function visibleWaveCards(
  layout: Pick<WaveLayout, "cards">,
  viewport: WaveViewport,
  margin = WAVE_CARD_WIDTH,
): ReadonlySet<string> {
  const left = viewport.left - margin;
  const top = viewport.top - margin;
  const right = viewport.left + viewport.width + margin;
  const bottom = viewport.top + viewport.height + margin;
  const visible = new Set<string>();
  for (const [key, box] of layout.cards) {
    if (box.x < right && box.x + box.width > left && box.y < bottom && box.y + box.height > top) {
      visible.add(key);
    }
  }
  return visible;
}
