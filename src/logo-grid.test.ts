// Regression guard for the hero wordmark's character grid.
//
// Two real bugs are pinned here:
//  1. Row-width drift: every ASCII_LOGO row must be exactly 61 columns wide,
//     otherwise the shadow rows (the box-drawing geometry under each glyph) stop
//     lining up with their letter rows.
//  2. Line-level centering: the wordmark <pre> elements must NOT use
//     text-center/text-align:center - that centers each line individually
//     (trailing spaces hang), which shifted the bottom shadow rows right off
//     the grid. Centering is done at block level (mx-auto w-fit).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ASCII_LOGO, COIN_GEOM, COIN_INK_AT } from "./components/term/ui";

const UI_TSX = fileURLToPath(new URL("./components/term/ui.tsx", import.meta.url));
const APP_TSX = fileURLToPath(new URL("./App.tsx", import.meta.url));
const CSS = fileURLToPath(new URL("./index.css", import.meta.url));

describe("hero wordmark grid", () => {
  it("every ASCII_LOGO row is exactly 61 columns wide (WEBQUID wordmark)", () => {
    // the template literal carries leading/trailing newlines - ignore blanks
    const rows = ASCII_LOGO.split("\n").filter((r) => r.length > 0);
    expect(rows.length).toBe(6);
    for (const row of rows) expect([...row].length).toBe(61);
  });

  it("W shadow rows keep the canonical ANSI Shadow geometry", () => {
    // unicode escapes keep this file pure-ASCII (hygiene rule)
    const BLK = "\u2588";
    const TL = "\u255a";
    const HZ = "\u2550";
    const BR = "\u255d";
    const rows = ASCII_LOGO.split("\n").filter((r) => r.length > 0);
    expect(rows[0].startsWith(BLK + BLK)).toBe(true); // row 1 flush-left
    expect(rows[4].startsWith(TL)).toBe(true); // row 5 flush-left
    expect(rows[5].startsWith(" ")).toBe(true); // row 6 offset +1 by font design
    expect(rows[5].slice(0, 10)).toBe(" " + TL + HZ + HZ + BR + TL + HZ + HZ + BR + " ");
  });

  it("the I glyph wears no tittle - the coin replaces it", () => {
    const BLK = "\u2588";
    const VR = "\u2551";
    const TL = "\u255a";
    const HZ = "\u2550";
    const BR = "\u255d";
    const rows = ASCII_LOGO.split("\n").filter((r) => r.length > 0);
    // I occupies columns 49-51 (0-based) of the 61-column grid: the top row
    // is blanked so the coin can ride there, the stem rows stay intact.
    expect(rows[0].slice(49, 52)).toBe("   ");
    for (let r = 1; r <= 4; r++) expect(rows[r].slice(49, 52)).toBe(BLK + BLK + VR);
    expect(rows[5].slice(49, 52)).toBe(TL + HZ + BR);
    // ...and every other glyph's top row is untouched
    expect([...rows[0]].filter((c) => c !== " ").length).toBeGreaterThan(30);
  });

  it("coin geometry stays pinned to spec (0.8x then 0.85x, on the stem)", () => {
    // Mockup (841x195 render): coin diameter 5.13ch, centered on the I glyph
    // (columns 49-51), center 1.07ch above the first glyph row. Shipped per
    // user spec: 0.8x the mockup, then a further 0.85x (= 0.68x, 3.49ch),
    // and centered on the stem's solid body (columns 49-50 -> 50.0ch), a
    // tick left of the glyph-box center.
    expect(COIN_GEOM.centerColCh).toBe(50.3);
    expect(COIN_GEOM.sizeEm / 0.6).toBeCloseTo(0.8 * 0.85 * 5.13, 1); // 3.49ch
    expect(COIN_GEOM.centerYEm).toBeGreaterThan(0);
    expect(COIN_GEOM.centerYEm).toBeLessThan(COIN_GEOM.sizeEm / 2 + 1.12);
    // fill-order threshold must sit inside the wordmark's own ink range,
    // and - letter-by-letter fill - well past the midpoint: the coin rides
    // the I (6th glyph of 7), so it lights when the fill reaches that glyph
    let inkTotal = 0;
    for (const ch of ASCII_LOGO) if (ch !== " " && ch !== "\n") inkTotal++;
    expect(COIN_INK_AT).toBeGreaterThan(inkTotal / 2);
    expect(COIN_INK_AT).toBeLessThan(inkTotal);
  });

  it("the coin flip is transform-only, occasional, and motion-safe", () => {
    const css = readFileSync(CSS, "utf8");
    const kf = css.match(/@keyframes wqd-coin-flip \{([\s\S]*?)\n {2}\}/);
    expect(kf).not.toBeNull();
    expect(kf![1]).toMatch(/transform:\s*rotateY/);
    // compositor-only: no layout/paint property may animate (the "sistemi
    // kasmadan" rule) - the flip must stay on the compositor thread
    expect(kf![1]).not.toMatch(
      /\b(top|left|right|bottom|width|height|margin|padding|opacity|filter|color|background)\s*:/,
    );
    // occasional: one spin per cycle of 10s+ (not a continuous loop), and
    // only when the user has not asked for reduced motion
    expect(css).toMatch(
      /prefers-reduced-motion:\s*no-preference[\s\S]*?animation:\s*wqd-coin-flip 1[0-9]s/,
    );
    // placement is ch/em + margins on the wrapper - the animated element
    // must not carry layout-affecting positioning itself
    expect(css).toMatch(/\.wqd-coin\s*\{[^}]*position:\s*absolute/);
  });

  it("ascii art blocks never use line-level text centering", () => {
    for (const file of [UI_TSX, APP_TSX]) {
      const src = readFileSync(file, "utf8");
      // Find every element carrying the .ascii glyph class and assert its
      // class attribute does not also request text-center (line centering
      // breaks the shared column grid; block centering is mx-auto w-fit).
      const matches = src.matchAll(/className=\{?"([^"]*\bascii\b[^"]*)"/g);
      let count = 0;
      for (const m of matches) {
        count += 1;
        expect(m[1]).not.toMatch(/\btext-center\b/);
        expect(m[1]).not.toMatch(/\btext-right\b/);
      }
      expect(count).toBeGreaterThan(0);
    }
  });
});
