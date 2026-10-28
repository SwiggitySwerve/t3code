/**
 * Where each card of a graph workflow sits: one column per wave, cards stacked in plan order.
 * The canvas gets an explicit size, because its cards are absolutely positioned and the chat
 * list measures each row's real height.
 *
 * A card is as tall as its own text needs: the step name takes one or two lines, and checker
 * rows add height only for nodes that have a checker. Every column still shares one row grid,
 * so the free strips between rows run across the whole canvas.
 */
export const WAVE_CARD_WIDTH = 216;
/** Space above and below a card's text. */
export const WAVE_CARD_PADDING = 12;
/** The card's 1px border, top and bottom. */
export const WAVE_CARD_BORDER = 2;
const STATUS_LINE_HEIGHT = 14;
const NAME_LINE_HEIGHT = 16;
/** The agent line and the tokens-and-time line. */
const DETAIL_LINE_HEIGHT = 14;
/** One checker row; a node shows at most two, and further attempts scroll inside them. */
export const WAVE_CHECKER_ROW_HEIGHT = 28;
export const WAVE_CHECKER_ROWS_VISIBLE = 2;
export const WAVE_COLUMN_GAP = 24;
/** Wide enough for a line that skips a wave to run between two cards. */
export const WAVE_ROW_GAP = 12;
export const WAVE_HEADER_HEIGHT = 22;

/** Width left for the step name beside the agent avatar. */
const NAME_WIDTH = 160;
const HISTORY_BUTTON_WIDTH = 24;
// Estimated advance of a 12px medium glyph. Deliberately wide, so a name judged to fit one line
// never wraps; a name judged to need two may occasionally leave a spare line of height.
const GLYPH_WIDTH = 6.2;
const SPACE_WIDTH = 3.4;
const CAPITAL_WIDTH = 7.6;
const WIDE_GLYPH_WIDTH = 12.5;
const WIDE_GLYPH =
  /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠\u{1f300}-\u{1faff}]/u;

function glyphWidth(glyph: string): number {
  if (WIDE_GLYPH.test(glyph)) return WIDE_GLYPH_WIDTH;
  return glyph !== glyph.toLowerCase() ? CAPITAL_WIDTH : GLYPH_WIDTH;
}

const textWidth = (text: string) => [...text].reduce((sum, glyph) => sum + glyphWidth(glyph), 0);

/** How many of the two allowed lines a step name needs; the card clamps the name to that many. */
export function waveNameLines(label: string, historyButton: boolean): 1 | 2 {
  const capacity = NAME_WIDTH - (historyButton ? HISTORY_BUTTON_WIDTH : 0);
  let lines = 1;
  let used = 0;
  for (const word of label.split(/\s+/).filter(Boolean)) {
    const width = textWidth(word);
    const space = used === 0 ? 0 : SPACE_WIDTH;
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

/** Attempts the node took, counted as the card's retry note counts them. */
export function waveNodeAttempts(node: {
  readonly attempts?: number | null;
  readonly member?: { readonly attempt: number | null } | null;
}): number {
  return node.attempts ?? (node.member?.attempt ?? 0) + 1;
}

/** What a node's own data decides about its card; the card draws exactly this. */
export interface WaveNodeInput {
  readonly key: string;
  readonly wave: number;
  readonly label?: string;
  readonly dependsOn?: ReadonlyArray<string>;
  readonly checkers?: ReadonlyArray<unknown>;
  readonly attempts?: number | null;
  readonly member?: { readonly attempt: number | null } | null;
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

function nodeBox(node: WaveNodeInput): Omit<WaveBox, "x" | "y"> {
  const historyButton = waveNodeAttempts(node) > 1;
  const nameLines = waveNameLines(node.label ?? "", historyButton);
  const checkerBand =
    Math.min(node.checkers?.length ?? 0, WAVE_CHECKER_ROWS_VISIBLE) * WAVE_CHECKER_ROW_HEIGHT;
  return {
    width: WAVE_CARD_WIDTH,
    height:
      WAVE_CARD_BORDER +
      WAVE_CARD_PADDING +
      STATUS_LINE_HEIGHT +
      nameLines * NAME_LINE_HEIGHT +
      2 * DETAIL_LINE_HEIGHT +
      checkerBand,
    nameLines,
    historyButton,
    checkerBand,
  };
}

export function workflowWaveLayout(waves: ReadonlyArray<ReadonlyArray<WaveNodeInput>>): WaveLayout {
  const sizes = waves.map((nodes) => nodes.map(nodeBox));
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
    const x = column * (WAVE_CARD_WIDTH + WAVE_COLUMN_GAP);
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
    width:
      waves.length === 0
        ? 0
        : waves.length * WAVE_CARD_WIDTH + (waves.length - 1) * WAVE_COLUMN_GAP,
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
