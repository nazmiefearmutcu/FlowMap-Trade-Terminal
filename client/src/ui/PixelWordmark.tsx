/**
 * The FlowMap wordmark for the pixel interface style.
 *
 * Seven capitals on a 5 × 7 grid, one cell apart, drawn as square cells. The
 * letters take `currentColor`, like the script mark. The single cell in the
 * middle of the O takes the theme accent: one lit level of the heatmap.
 *
 * The glyphs are data, so the mark needs no font and stays sharp at any whole
 * multiple of its grid.
 */

/** Rows top to bottom; `#` is a filled cell. */
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
};

const WORD = 'FLOWMAP';
const GLYPH_W = 5;
const GLYPH_H = 7;
const ADVANCE = GLYPH_W + 1;

export const PIXEL_WORDMARK_WIDTH = WORD.length * ADVANCE - 1;
export const PIXEL_WORDMARK_HEIGHT = GLYPH_H;

/** One `M x y h1 v1 h-1 z` square per filled cell. */
export function pixelWordmarkPath(word: string = WORD): string {
  const cells: string[] = [];
  [...word].forEach((letter, index) => {
    const rows = GLYPHS[letter];
    if (!rows) throw new Error(`PixelWordmark has no glyph for ${letter}`);
    rows.forEach((row, y) => {
      [...row].forEach((cell, x) => {
        if (cell === '#') cells.push(`M${index * ADVANCE + x} ${y}h1v1h-1z`);
      });
    });
  });
  return cells.join('');
}

const PATH = pixelWordmarkPath();
/** The centre cell of the O. */
const HEAT_X = WORD.indexOf('O') * ADVANCE + 2;
const HEAT_Y = 3;

interface PixelWordmarkProps {
  /** Rendered height in px. A multiple of 7 keeps every cell on whole pixels. */
  height?: number;
  className?: string;
}

export function PixelWordmark({ height = 14, className }: PixelWordmarkProps): JSX.Element {
  return (
    <svg
      className={className}
      height={height}
      width={(height / PIXEL_WORDMARK_HEIGHT) * PIXEL_WORDMARK_WIDTH}
      viewBox={`0 0 ${PIXEL_WORDMARK_WIDTH} ${PIXEL_WORDMARK_HEIGHT}`}
      role="img"
      aria-label="FlowMap"
      focusable="false"
    >
      <path d={PATH} fill="currentColor" />
      <rect className="wordmark__heat" x={HEAT_X} y={HEAT_Y} width={1} height={1} />
    </svg>
  );
}
