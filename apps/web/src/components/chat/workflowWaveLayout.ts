/**
 * Where each card of a graph workflow sits: one column per wave, cards stacked in plan order.
 * The canvas gets an explicit size, because its cards are absolutely positioned and the chat
 * list measures each row's real height.
 */
export const WAVE_CARD_WIDTH = 208;
export const WAVE_CARD_HEIGHT = 72;
export const WAVE_COLUMN_GAP = 28;
/** Wide enough for a line that skips a wave to run between two cards. */
export const WAVE_ROW_GAP = 12;
export const WAVE_HEADER_HEIGHT = 22;

export interface WaveBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
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

export function workflowWaveLayout(
  waves: ReadonlyArray<
    ReadonlyArray<{
      readonly key: string;
      readonly wave: number;
      readonly dependsOn?: ReadonlyArray<string>;
      readonly checkers?: ReadonlyArray<unknown>;
    }>
  >,
): WaveLayout {
  const cards = new Map<string, WaveBox>();
  const cardHeight =
    WAVE_CARD_HEIGHT + Math.max(0, ...waves.flat().map((node) => node.checkers?.length ?? 0)) * 28;
  const columns = waves.map((nodes, column) => {
    const x = column * (WAVE_CARD_WIDTH + WAVE_COLUMN_GAP);
    nodes.forEach((node, row) => {
      cards.set(node.key, {
        x,
        y: WAVE_HEADER_HEIGHT + row * (cardHeight + WAVE_ROW_GAP),
        width: WAVE_CARD_WIDTH,
        height: cardHeight,
      });
    });
    return { wave: nodes[0]?.wave ?? column, x };
  });
  const rows = Math.max(0, ...waves.map((nodes) => nodes.length));
  // Every column shares one row grid, so the gaps between rows (and the strip below the last
  // row) are free in every column; a line that skips a wave runs along one of them.
  const laneY = (row: number) =>
    WAVE_HEADER_HEIGHT + row * (cardHeight + WAVE_ROW_GAP) - WAVE_ROW_GAP / 2;
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
          rows * cardHeight +
          (rows - 1) * WAVE_ROW_GAP +
          (usesBottomLane ? WAVE_ROW_GAP : 0),
    columns,
    cards,
    edges,
  };
}
