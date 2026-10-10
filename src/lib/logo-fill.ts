/**
 * Letter-by-letter fill order for the big Terminal wordmark (SupplyLogo).
 *
 * The ASCII logo is 7 glyphs (W E B Q U I D) on a fixed character grid.
 * The progress fill no longer wipes the art in raw string order (row-major:
 * the top band of EVERY letter first, then the next band - a horizontal
 * curtain). Instead it flows through the WORD: the W fills completely,
 * then the E, then B, Q, U, I, D - one whole letter at a time, so the logo
 * reads as a progress bar advancing letter by letter. Within a letter the
 * fill still runs top-to-bottom in grid order, so a letter "pours" full.
 *
 * Everything here is derived from the logo string itself - column groups
 * are detected from the ink, never hardcoded - and pure, so the render
 * component stays a thin shell and the rules are unit-testable.
 */

/** One detected glyph: its column span on the grid and its ink count. */
export interface LetterSpan {
  fromCol: number;
  toCol: number;
  ink: number;
}

export interface LogoFillPlan {
  /** Total ink (non-space, non-newline) characters in the logo. */
  inkTotal: number;
  /** The glyphs, left to right in word order. */
  letters: LetterSpan[];
  /**
   * string index -> fill rank (0..inkTotal-1) for ink characters;
   * -1 for spaces/newlines (they carry no ink and render invisibly).
   */
  rankAt: Int32Array;
  /** fill rank -> string index; length inkTotal. */
  indexAtRank: Uint32Array;
  /**
   * The bright-ink count at which the fill REACHES the letter that carries
   * the coin tittle (the I): the number of ink characters in every letter
   * strictly left of it. The coin lights when brightInk passes this mark.
   */
  coinAt: number;
}

/**
 * Build the fill plan for a logo string. `coinColumn` is any grid column
 * inside the coin-bearing letter (the I) - the plan finds the glyph under
 * that column and marks where the fill reaches it.
 */
export function computeLogoFillPlan(logo: string, coinColumn: number): LogoFillPlan {
  const rows = logo.split("\n");
  // Union of inked columns across every row, then contiguous runs = glyphs.
  // Adjacent ANSI Shadow letters are separated by at least one column that
  // is empty in EVERY row, so runs never merge two glyphs.
  const inkedCols = new Set<number>();
  for (const row of rows) {
    for (let c = 0; c < row.length; c++) {
      if (row[c] !== " ") inkedCols.add(c);
    }
  }
  const spans: Array<[number, number]> = [];
  let open = -1;
  const maxCol = Math.max(...rows.map((r) => r.length), 0);
  for (let c = 0; c <= maxCol; c++) {
    if (inkedCols.has(c)) {
      if (open === -1) open = c;
    } else if (open !== -1) {
      spans.push([open, c - 1]);
      open = -1;
    }
  }

  // Fill order: letters left to right; inside a letter, raw string order
  // (row by row, top to bottom - the letter pours full).
  const rankAt = new Int32Array(logo.length).fill(-1);
  const indexAtRank = new Uint32Array(logo.length);
  const letters: LetterSpan[] = [];
  const coinSpanIdx = spans.findIndex(([a, b]) => a <= coinColumn && coinColumn <= b);
  let rank = 0;
  let coinAt = 0;
  spans.forEach(([fromCol, toCol], spanIdx) => {
    if (spanIdx === coinSpanIdx) coinAt = rank; // everything so far is left of the coin letter
    let ink = 0;
    let col = -1;
    for (let i = 0; i < logo.length; i++) {
      const ch = logo[i];
      if (ch === "\n") {
        col = -1;
        continue;
      }
      col++;
      if (ch === " " || col < fromCol || col > toCol) continue;
      rankAt[i] = rank;
      indexAtRank[rank] = i;
      rank++;
      ink++;
    }
    letters.push({ fromCol, toCol, ink });
  });

  return { inkTotal: rank, letters, rankAt, indexAtRank, coinAt };
}

// -- rendering --------------------------------------------------------------------

export type FillClass = "bright" | "cursor" | "dim";

export interface FillRun {
  cls: FillClass;
  text: string;
}

/**
 * Split the logo into render runs for a given bright-ink count: every ink
 * character below the count (in fill order) is bright, the boundary
 * character is the blinking cursor edge, the rest is dim. The cursor run
 * is always exactly ONE glyph (its span carries the blink); spaces ride
 * along with whatever run is open - they paint nothing either way.
 * brightInk >= inkTotal yields a single all-bright run (no cursor).
 */
export function fillRuns(logo: string, plan: LogoFillPlan, brightInk: number): FillRun[] {
  const bright = Math.max(0, Math.min(plan.inkTotal, Math.floor(brightInk)));
  const runs: FillRun[] = [];
  let open: FillRun | null = null;
  const push = (cls: FillClass, ch: string) => {
    if (open && open.cls === cls) {
      open.text += ch;
    } else {
      open = { cls, text: ch };
      runs.push(open);
    }
  };
  for (let i = 0; i < logo.length; i++) {
    const ch = logo[i];
    const r = plan.rankAt[i];
    if (r === -1) {
      // no ink: append to the open run, or park it in a leading bright run
      push(open ? open.cls : "bright", ch);
    } else if (r < bright) {
      push("bright", ch);
    } else if (r === bright) {
      runs.push({ cls: "cursor", text: ch });
      open = null; // the edge glyph stands alone - nothing may join its span
    } else {
      push("dim", ch);
    }
  }
  return runs;
}
