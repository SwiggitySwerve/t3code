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

export interface WaveLayout {
  readonly width: number;
  readonly height: number;
  readonly columns: ReadonlyArray<{ readonly wave: number; readonly x: number }>;
  readonly cards: ReadonlyMap<string, WaveBox>;
}

export function workflowWaveLayout(
  waves: ReadonlyArray<ReadonlyArray<{ readonly key: string; readonly wave: number }>>,
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
  };
}
