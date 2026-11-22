// The on-screen keyboard's layouts and D-pad maths (pure, unit-tested). Every layout is a grid of COLS equal
// columns; a key spans whole cells, and every row's spans add up to COLS, so the columns always line up.

export const COLS = 10;

const chars = (s) => [...s].map((ch) => ({ ch }));

/** The bottom row, the same in every layout (only the layout toggle's label changes). */
function bottomRow(layout) {
  return [
    { id: 'shift', label: 'Shift', span: 2 },
    { id: 'layout', label: layout === 'letters' ? '#+=' : 'ABC', aria: layout === 'letters' ? 'Symbols and numbers' : 'Letters', span: 1 },
    { id: 'space', label: 'Space', span: 3 },
    { id: 'backspace', label: '⌫', aria: 'Backspace', span: 1 },
    { id: 'clear', label: 'Clear', span: 1 },
    { id: 'done', label: 'Done', span: 2, primary: true },
  ];
}

const LETTERS = ['1234567890', 'qwertyuiop', 'asdfghjkl_', 'zxcvbnm-.@'];
// The punctuation row for chat (symbols: true).
const PUNCTUATION = "!?,':;()#/";
const SYMBOLS = ['1234567890', '!@#$%^&*()', '-_=+[]{}\\|', '~`"\':;,.?/'];
const SYMBOLS_EXTRA = '<>«»¡¿€£°…';

/**
 * @param {'letters'|'symbols'} layout
 * @param {{chat?: boolean}} [opts] chat adds a fifth row of characters (punctuation on the letters layout), so both
 *   layouts keep the same number of rows and the keyboard doesn't change size when you switch.
 * @returns {{ch?: string, id?: string, label?: string, aria?: string, span?: number, primary?: boolean}[][]}
 */
export function oskLayout(layout, { chat = false } = {}) {
  const rows = layout === 'symbols'
    ? [...SYMBOLS, ...(chat ? [SYMBOLS_EXTRA] : [])]
    : [...LETTERS, ...(chat ? [PUNCTUATION] : [])];
  return [...rows.map(chars), bottomRow(layout)];
}

export const span = (key) => key.span || 1;

/** The key index covering each column of a row. */
export function columnMap(row) {
  const out = [];
  row.forEach((key, i) => { for (let n = 0; n < span(key); n++) out.push(i); });
  return out;
}

/** The first column a key covers. */
export function startColumn(row, index) {
  let col = 0;
  for (let i = 0; i < index; i++) col += span(row[i]);
  return col;
}

/** The key under a position: {row, col}. */
export function keyIndexAt(rows, { row, col }) {
  const map = columnMap(rows[row]);
  return map[Math.min(Math.max(col, 0), map.length - 1)];
}

/**
 * One D-pad step. A position is {row, col}: `col` is the column you are "in", which up/down keep, so passing through
 * a wide key (Space) and back lands on the key you came from. Left/right move one key and wrap at the row's ends; up/down
 * stop at the top and bottom rows (returns null there).
 */
export function oskMove(rows, pos, dir) {
  const { row, col } = pos;
  if (dir === 'UP' || dir === 'DOWN') {
    const r = row + (dir === 'UP' ? -1 : 1);
    if (r < 0 || r >= rows.length) return null;
    return { row: r, col };
  }
  if (dir === 'LEFT' || dir === 'RIGHT') {
    const keys = rows[row];
    const i = keyIndexAt(rows, pos);
    const j = (i + (dir === 'LEFT' ? -1 : 1) + keys.length) % keys.length;
    return { row, col: startColumn(keys, j) };
  }
  return null;
}
