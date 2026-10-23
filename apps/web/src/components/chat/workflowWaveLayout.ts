/**
 * Where each card of a graph workflow sits: one column per wave, cards stacked in plan order.
 * The canvas gets an explicit size, because its cards are absolutely positioned and the chat
 * list measures each row's real height.
 */
export const WAVE_CARD_WIDTH = 208;
export const WAVE_CARD_HEIGHT = 52;
export const WAVE_COLUMN_GAP = 28;
export const WAVE_ROW_GAP = 8;
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
    }>
  >,
): WaveLayout {
  const cards = new Map<string, WaveBox>();
  const columns = waves.map((nodes, column) => {
    const x = column * (WAVE_CARD_WIDTH + WAVE_COLUMN_GAP);
    nodes.forEach((node, row) => {
      cards.set(node.key, {
        x,
        y: WAVE_HEADER_HEIGHT + row * (WAVE_CARD_HEIGHT + WAVE_ROW_GAP),
        width: WAVE_CARD_WIDTH,
        height: WAVE_CARD_HEIGHT,
      });
    });
    return { wave: nodes[0]?.wave ?? column, x };
  });
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
      const bend = (x2 - x1) / 2;
      edges.push({
        from: dep,
        to: node.key,
        path: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
      });
    }
  }
  const rows = Math.max(0, ...waves.map((nodes) => nodes.length));
  return {
    width:
      waves.length === 0
        ? 0
        : waves.length * WAVE_CARD_WIDTH + (waves.length - 1) * WAVE_COLUMN_GAP,
    height:
      rows === 0 ? 0 : WAVE_HEADER_HEIGHT + rows * WAVE_CARD_HEIGHT + (rows - 1) * WAVE_ROW_GAP,
    columns,
    cards,
    edges,
  };
}
