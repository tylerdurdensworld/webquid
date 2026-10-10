/**
 * Letter-by-letter fill order tests - the wordmark progress bar must fill
 * whole glyphs in word order (W, then E, then B, Q, U, I, D), never as a
 * row-major horizontal curtain. The plan is derived from the logo string,
 * so these tests pin the RULES, not a frozen art file.
 */
import { describe, expect, it } from "vitest";
import { computeLogoFillPlan, fillRuns } from "./logo-fill";
import { ASCII_LOGO, COIN_GEOM } from "@/components/term/ui";

const LOGO = ASCII_LOGO.trimEnd();
const COIN_COL = Math.floor(COIN_GEOM.centerColCh); // the I's column (50)
const plan = computeLogoFillPlan(LOGO, COIN_COL);

/** letter index of a string index, via the plan's spans + grid columns */
function letterOfIndex(index: number): number {
  let col = -1;
  for (let i = 0; i <= index; i++) {
    if (LOGO[i] === "\n") col = -1;
    else col++;
  }
  return plan.letters.findIndex((l) => l.fromCol <= col && col <= l.toCol);
}

describe("computeLogoFillPlan", () => {
  it("detects exactly the 7 wordmark glyphs, left to right, with ink in each", () => {
    expect(plan.letters).toHaveLength(7);
    for (let i = 1; i < 7; i++) {
      expect(plan.letters[i].fromCol).toBeGreaterThan(plan.letters[i - 1].toCol);
    }
    for (const l of plan.letters) expect(l.ink).toBeGreaterThan(0);
  });

  it("every ink character gets exactly one rank - a clean permutation", () => {
    let inkTotal = 0;
    for (const ch of LOGO) if (ch !== " " && ch !== "\n") inkTotal++;
    expect(plan.inkTotal).toBe(inkTotal);
    const seen = new Set<number>();
    for (let i = 0; i < LOGO.length; i++) {
      const ch = LOGO[i];
      if (ch === " " || ch === "\n") {
        expect(plan.rankAt[i]).toBe(-1);
        continue;
      }
      const r = plan.rankAt[i];
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(plan.inkTotal);
      expect(seen.has(r)).toBe(false);
      seen.add(r);
      expect(plan.indexAtRank[r]).toBe(i);
    }
    expect(seen.size).toBe(plan.inkTotal);
  });

  it("fill order is letter-major: a glyph's ranks all precede the next glyph's", () => {
    let prevLetter = 0;
    for (let r = 0; r < plan.inkTotal; r++) {
      const letter = letterOfIndex(plan.indexAtRank[r]);
      expect(letter).toBeGreaterThanOrEqual(prevLetter);
      prevLetter = letter;
    }
    // ...and the LAST rank belongs to the last glyph (the D)
    expect(letterOfIndex(plan.indexAtRank[plan.inkTotal - 1])).toBe(6);
  });

  it("within a letter the fill pours top-to-bottom in grid order", () => {
    for (let li = 0; li < 7; li++) {
      const idxs: number[] = [];
      for (let r = 0; r < plan.inkTotal; r++) {
        if (letterOfIndex(plan.indexAtRank[r]) === li) idxs.push(plan.indexAtRank[r]);
      }
      const sorted = [...idxs].sort((a, b) => a - b);
      expect(idxs).toEqual(sorted);
      expect(idxs).toHaveLength(plan.letters[li].ink);
    }
  });

  it("coinAt is the ink of every letter left of the I - the coin lights when the fill reaches the I", () => {
    // the coin-bearing glyph is the 6th of 7 (the I, second-to-last)
    const inkBefore = plan.letters.slice(0, 5).reduce((s, l) => s + l.ink, 0);
    expect(plan.coinAt).toBe(inkBefore);
    expect(plan.coinAt).toBeGreaterThan(plan.inkTotal / 2); // letter-major position
    expect(plan.coinAt).toBeLessThan(plan.inkTotal);
    // the rank AT coinAt is the I's first ink character
    expect(letterOfIndex(plan.indexAtRank[plan.coinAt])).toBe(5);
  });
});

describe("fillRuns", () => {
  const concat = (runs: Array<{ text: string }>) => runs.map((r) => r.text).join("");

  it("runs always reassemble the exact logo string", () => {
    for (const b of [0, 1, 17, 100, plan.coinAt, plan.inkTotal - 1, plan.inkTotal, plan.inkTotal + 50]) {
      expect(concat(fillRuns(LOGO, plan, b))).toBe(LOGO);
    }
  });

  it("zero progress: the cursor sits on the W's first ink, everything else dim", () => {
    const runs = fillRuns(LOGO, plan, 0);
    const cursor = runs.filter((r) => r.cls === "cursor");
    expect(cursor).toHaveLength(1);
    expect(cursor[0].text).toHaveLength(1);
    // the rank-0 character is the W's first ink (top-left of the word)
    expect(letterOfIndex(plan.indexAtRank[0])).toBe(0);
    expect(cursor[0].text).toBe(LOGO[plan.indexAtRank[0]]);
    expect(runs.filter((r) => r.cls === "bright").every((r) => !/[^ \n]/.test(r.text))).toBe(true);
  });

  it("a mid-word boundary: exactly one partial letter - earlier full, later empty", () => {
    // bright ink ending mid-E (letter 1): 48 (W) + 20 of E's 44
    const runs = fillRuns(LOGO, plan, 48 + 20);
    const brightInkPerLetter = new Array(7).fill(0);
    const dimInkPerLetter = new Array(7).fill(0);
    let i = 0;
    for (const run of runs) {
      for (const ch of run.text) {
        const chGlobalIdx = i++;
        if (ch === " " || ch === "\n") continue;
        const li = letterOfIndex(chGlobalIdx);
        if (run.cls === "bright") brightInkPerLetter[li]++;
        else if (run.cls !== "cursor") dimInkPerLetter[li]++;
      }
    }
    expect(brightInkPerLetter[0]).toBe(plan.letters[0].ink); // W complete
    expect(dimInkPerLetter[0]).toBe(0);
    expect(brightInkPerLetter[1]).toBe(20); // E partial
    for (let li = 2; li < 7; li++) {
      expect(brightInkPerLetter[li]).toBe(0);
      expect(dimInkPerLetter[li]).toBe(plan.letters[li].ink);
    }
  });

  it("full progress: one all-bright run and no cursor", () => {
    const runs = fillRuns(LOGO, plan, plan.inkTotal);
    expect(runs.every((r) => r.cls === "bright")).toBe(true);
    expect(concat(runs)).toBe(LOGO);
  });

  it("the boundary letter's cursor is exactly one character", () => {
    for (const b of [0, 5, 48, 49, 92, plan.coinAt, plan.inkTotal - 1]) {
      const cursors = fillRuns(LOGO, plan, b).filter((r) => r.cls === "cursor");
      expect(cursors).toHaveLength(1);
      expect(cursors[0].text).toHaveLength(1);
    }
  });
});
