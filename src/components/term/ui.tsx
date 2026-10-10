import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { COIN } from "@contracts/protocol";
import { BOOT_SWEEP_MS, bootSweepFillAt } from "@/lib/bootfill";
import { computeLogoFillPlan, fillRuns } from "@/lib/logo-fill";
import { fmtInt } from "@/lib/format";
import { cn } from "@/lib/utils";

/* -- Panel ---------------------------------------------------------------- */
export function Panel({
  title,
  right,
  children,
  className,
  bodyClassName,
}: {
  title: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn("term-panel", className)}>
      <header className="flex items-center justify-between gap-2 border-b border-neutral-700 px-3 py-1.5">
        <span className="term-panel-title">{title}</span>
        {right ? <span className="text-xs text-neutral-500">{right}</span> : null}
      </header>
      <div className={cn("p-4", bodyClassName)}>{children}</div>
    </section>
  );
}

/* -- Stat ----------------------------------------------------------------- */
export function Stat({
  label,
  value,
  sub,
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("border border-neutral-800 bg-black/70 px-3 py-2", className)}>
      <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">{label}</div>
      <div className="font-term glow-soft mt-0.5 truncate text-2xl leading-none text-neutral-100">
        {value}
      </div>
      {sub ? <div className="mt-0.5 truncate text-[11px] text-neutral-500">{sub}</div> : null}
    </div>
  );
}

/* -- Cursor --------------------------------------------------------------- */
export function Cursor({ className }: { className?: string }) {
  return <span className={cn("blink inline-block", className)}>_</span>;
}

/* -- Copy button ---------------------------------------------------------- */
export function CopyBtn({ text, label = "COPY" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="term-btn px-2 py-0.5 text-[11px]"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const ta = document.createElement("textarea");
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
        }
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? "COPIED" : label}
    </button>
  );
}

/* -- Terminal progress bar --------------------------------------------------
 * Text-glyph bar in the phosphor idiom: determinate when the operation can
 * measure itself (blocks verified/applied/fetched), a pulsing frame when it
 * cannot - a wait must never look frozen. Pure-ASCII glyphs (#/-) so the bar
 * renders in the surrounding terminal font on every platform.
 */
export function TerminalProgressBar({
  current,
  total,
  className,
}: {
  /** determinate numbers; pass null/null for the indeterminate pulse */
  current: number | null;
  total: number | null;
  className?: string;
}) {
  const WIDTH = 26;
  const determinate =
    current !== null && total !== null && Number.isFinite(current) && Number.isFinite(total) && total > 0;
  const ratio = determinate ? Math.min(1, Math.max(0, current / total)) : 0;
  const filled = Math.round(ratio * WIDTH);
  const pct = determinate ? Math.floor(ratio * 100) : null;
  // The bar is one unbreakable glyph string, so IT must adapt to the panel
  // - never the other way round. The font size scales with the viewport
  // (browser text zoom shrinks the CSS viewport, so zoom self-corrects).
  // The percent is a flex SIBLING, not part of the clipped nowrap string:
  // under aggressive mobile text scaling (iOS Larger Text) the unbreakable
  // bar is the element that clips, while " 42%" - the info the user is
  // actually watching - always renders whole (it used to sit INSIDE the
  // overflow-hidden line and was the first thing cut off).
  return (
    <div
      data-testid="terminal-progress-bar"
      data-determinate={determinate || undefined}
      className={cn(
        "mx-auto flex w-fit max-w-full select-none items-center justify-center text-[clamp(11px,4vw,15px)] text-neutral-200",
        !determinate && "blink",
        className,
      )}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={determinate ? 100 : undefined}
      aria-valuenow={pct ?? undefined}
    >
      {/* no text-center on .ascii: when the unbreakable bar does clip, the
          fill must stay anchored left; and line centering breaks multi-line
          ascii art grids (see logo-grid.test.ts) */}
      <span className="ascii min-w-0 overflow-hidden whitespace-nowrap">
        [{"#".repeat(filled)}
        {"-".repeat(WIDTH - filled)}]
      </span>
      {pct !== null ? (
        <span className="shrink-0 tabular-nums"> {pct}%</span>
      ) : null}
    </div>
  );
}

/* -- Status line ---------------------------------------------------------- */
export function StatusLine({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <div
      // [overflow-wrap:anywhere]: status text can carry a raw 64-char txid
      // (one unbreakable token) - anywhere lets it wrap mid-token instead of
      // spilling out of the box on narrow screens (the mobile overflow bug).
      className={cn(
        "border px-2 py-1 text-xs [overflow-wrap:anywhere]",
        ok ? "border-neutral-500 text-neutral-200" : "border-neutral-700 text-neutral-400",
      )}
    >
      <span className="mr-2 font-bold">{ok ? "[OK]" : "[ERR]"}</span>
      {children}
    </div>
  );
}

/* -- ASCII logo ----------------------------------------------------------- */
export const ASCII_LOGO = String.raw`
██╗    ██╗ ███████╗ ██████╗   ██████╗  ██╗   ██╗     ██████╗ 
██║    ██║ ██╔════╝ ██╔══██╗ ██╔═══██╗ ██║   ██║ ██║ ██╔══██╗
██║ █╗ ██║ █████╗   ██████╔╝ ██║   ██║ ██║   ██║ ██║ ██║  ██║
██║███╗██║ ██╔══╝   ██╔══██╗ ██║▄▄ ██║ ██║   ██║ ██║ ██║  ██║
╚███╔███╔╝ ███████╗ ██████╔╝ ╚██████╔╝ ╚██████╔╝ ██║ ██████╔╝
 ╚══╝╚══╝  ╚══════╝ ╚═════╝   ╚══▀▀═╝   ╚═════╝  ╚═╝ ╚═════╝ 
`;

/**
 * Fit the 61-column wordmark to its container, deterministically: set the
 * cap size, MEASURE the real rendered width, then shrink linearly until it
 * fits. Viewport-unit clamps fail here twice over - vw ignores container
 * padding, and Android text scaling inflates font-size without inflating
 * vw. Measuring the rendered result converges in one pass (monospace width
 * is linear in font-size) and is immune to both.
 */
// cap 18.3678 = 12 * 1.10^3 * 1.15: the WebQuid rebrand bumped the wordmark
// a further 15% on top of the original 33% enlargement wherever it fits
// (desktop/tablet). Narrow phones stay at the width-limited fitted size.
/* -- The wordmark coin ------------------------------------------------------
 * The I of WEBQUID wears a coin for its tittle (reference mockup), shipped
 * at 0.8x the mockup's coin size. All geometry is pinned to the character
 * grid (ch/em), so useWordmarkFit's font scaling keeps the coin glued to
 * the I glyph at every size and DPR. Mockup measurements (841x195 render):
 * coin diameter 5.13ch, centered on the I glyph (columns 49-51 -> 50.5ch),
 * center 1.07ch above the first glyph row -> shipped at 4.1ch (0.8x), same
 * center. Vertical anchor: the <pre> opens with one empty line (the
 * template literal's leading newline) at line-height 1.12, which puts the
 * first glyph row's ink ~1.18em below the pre's top edge; coin center =
 * 1.18 - 0.64 = 0.54em.
 */
export const COIN_GEOM = {
  // centered on the I stem's SOLID body (columns 49-50), then nudged a hair
  // right and down on review: 50.3ch keeps the coin on the stem body while
  // visually centering it over the glyph's ink mass (the shadow column at
  // 51 pulls the eye right), and 0.62em seats it a touch closer to the
  // letter tops so it reads perched, not floating
  centerColCh: 50.3,
  // 3.49ch = the mockup's 5.13ch at 0.8x, then a further 0.85x on request
  sizeEm: 2.09,
  centerYEm: 0.62, // coin center below the pre's top edge
} as const;

// The coin's light threshold in the letter-by-letter supply fill: the
// number of ink characters in every letter strictly LEFT of the coin's own
// glyph (W+E+B+Q+U), so the coin lights up exactly when the fill reaches
// the I it rides on. Derived from the logo string by lib/logo-fill (never
// hardcoded); SupplyLogo reuses the same module-level plan for its runs.
const LOGO_FILL_PLAN = computeLogoFillPlan(
  ASCII_LOGO.trimEnd(),
  Math.floor(COIN_GEOM.centerColCh), // a column inside the coin's glyph
);
export const COIN_INK_AT = LOGO_FILL_PLAN.coinAt;

function CoinFace({ back = false }: { back?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 100 100"
      focusable="false"
      className={back ? "wqd-coin-face wqd-coin-back" : "wqd-coin-face"}
    >
      <circle cx="50" cy="50" r="46" fill="none" stroke="currentColor" strokeWidth="6" />
      {/* Filled face with the brand W knocked out NEGATIVE (black on ink),
          like the reference mockup. The W is NOT hand-drawn: it is the
          favicon's own W (public/icon-512.png) pixel-vectorized into merged
          grid runs - outline stripes, groove channels, stepped center peak
          and feet included - so the coin carries the exact brand glyph at
          every size. Max ink radius 38.4 stays inside the r40 face. */}
      <circle cx="50" cy="50" r="40" fill="currentColor" />
      <path d="M24.0 21.7h10.6v3.8h-10.6z M24.0 25.5h11.3v0.8h-11.3z M61.7 21.7h10.6v4.5h-10.6z M61.7 26.3h14.3v0.8h-14.3z M24.0 26.3h14.3v0.8h-14.3z M61.7 27.0h10.6v0.8h-10.6z M24.0 27.0h11.3v0.8h-11.3z M24.0 27.8h12.8v0.8h-12.8z M61.7 27.8h12.8v0.8h-12.8z M45.9 41.3h4.5v0.8h-4.5z M45.1 42.1h6.0v3.8h-6.0z M45.1 45.9h9.0v0.8h-9.0z M45.1 46.6h6.0v0.8h-6.0z M45.1 47.4h7.5v0.8h-7.5z M51.9 48.1h1.5v0.8h-1.5z M52.6 48.9h0.8v2.3h-0.8z M54.1 46.6h0.8v4.5h-0.8z M45.1 48.1h6.0v3.8h-6.0z M51.9 51.1h3.0v0.8h-3.0z M39.8 51.9h16.6v3.8h-16.6z M39.8 55.7h19.6v0.8h-19.6z M39.8 56.4h20.3v0.8h-20.3z M39.8 57.2h16.6v0.8h-16.6z M39.8 57.9h18.8v0.8h-18.8z M39.8 58.7h16.6v3.0h-16.6z M36.1 28.5h0.8v33.2h-0.8z M24.0 28.5h10.6v33.2h-10.6z M57.9 58.7h0.8v3.0h-0.8z M61.7 28.5h10.6v33.2h-10.6z M37.6 27.0h0.8v34.7h-0.8z M59.4 57.2h0.8v4.5h-0.8z M24.0 61.7h48.2v0.8h-48.2z M27.0 62.4h0.8v3.8h-0.8z M29.3 62.4h16.6v3.8h-16.6z M73.7 28.5h0.8v37.7h-0.8z M50.4 62.4h16.6v3.8h-16.6z M27.0 66.2h18.8v0.8h-18.8z M68.5 66.2h6.0v0.8h-6.0z M46.6 66.2h20.3v0.8h-20.3z M75.2 27.0h0.8v40.7h-0.8z M29.3 67.0h16.6v0.8h-16.6z M25.5 62.4h0.8v5.3h-0.8z M46.6 67.0h1.5v0.8h-1.5z M50.4 67.0h16.6v0.8h-16.6z M70.0 67.7h6.0v0.8h-6.0z M25.5 67.7h20.3v0.8h-20.3z M46.6 67.7h20.3v0.8h-20.3z M29.3 68.5h16.6v3.8h-16.6z M50.4 68.5h16.6v3.8h-16.6z M51.1 72.2h15.8v0.8h-15.8z M29.3 72.2h15.8v0.8h-15.8z M46.6 68.5h3.0v7.5h-3.0z M68.5 67.0h0.8v9.0h-0.8z M54.1 73.0h0.8v3.0h-0.8z M32.3 73.0h0.8v3.0h-0.8z M54.1 76.0h15.1v0.8h-15.1z M32.3 76.0h17.3v0.8h-17.3z M30.8 73.0h0.8v4.5h-0.8z M70.0 68.5h0.8v9.0h-0.8z M51.9 73.0h1.5v4.5h-1.5z M48.1 76.8h1.5v0.8h-1.5z M30.8 77.5h18.8v0.8h-18.8z M51.9 77.5h18.8v0.8h-18.8z" fill="#000" />
    </svg>
  );
}

/** The coin tittle. The wrapper places it with ch/em margins only - never
 *  transform, because the flip animation owns transform on the inner
 *  element: one 0.9s spin every 13s, transform-only (compositor thread, no
 *  layout, no paint), and switched off entirely by prefers-reduced-motion.
 *  Two faces keep the W readable through the flip, like a real coin. */
export function WordmarkCoin({ lit = true }: { lit?: boolean }) {
  return (
    <span
      aria-hidden="true"
      data-testid="wordmark-coin"
      className={cn("wqd-coin", !lit && "wqd-coin--dim")}
      style={{
        left: `${COIN_GEOM.centerColCh}ch`,
        top: `${COIN_GEOM.centerYEm}em`,
        width: `${COIN_GEOM.sizeEm}em`,
        height: `${COIN_GEOM.sizeEm}em`,
        marginLeft: `${-COIN_GEOM.sizeEm / 2}em`,
        marginTop: `${-COIN_GEOM.sizeEm / 2}em`,
      }}
    >
      <span className="wqd-coin-spin" data-testid="wordmark-coin-spin">
        <CoinFace />
        <CoinFace back />
      </span>
    </span>
  );
}

/** The brand coin as a standalone inline badge - the exact same two-face
 *  flip construction as the I's tittle (CoinFace x2 on a preserve-3d
 *  spinner), but placed by normal flow instead of the wordmark's ch grid.
 *  Sizing is em-based (2em box): the parent's font-size sets the coin's
 *  diameter. The flip cadence is owned entirely by CSS - .wqd-brandcoin
 *  overrides the tittle's 13s loop with the money-popup's 3s loop - and
 *  reduced motion keeps the coin static. Used by the transfer popups. */
export function BrandCoin({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" data-testid="brand-coin" className={cn("wqd-brandcoin", className)}>
      <span className="wqd-coin-spin" data-testid="brand-coin-spin">
        <CoinFace />
        <CoinFace back />
      </span>
    </span>
  );
}

function useWordmarkFit<T extends HTMLElement>(cap = 18.3678, floor = 4) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!el || !parent) return undefined;
    const fit = () => {
      el.style.fontSize = `${cap}px`;
      // scrollWidth, not the border box: max-w-full caps the ELEMENT at the
      // parent while the glyphs paint past it - only the content width tells
      // the truth (measuring the capped box was the phone overflow bug).
      const w = el.scrollWidth;
      const avail = parent.clientWidth;
      let size = cap;
      if (w > 0 && w > avail) {
        size = Math.max(floor, Math.floor((avail / w) * cap * 0.98 * 100) / 100);
      }
      // Device-pixel snap: every glyph in the .ascii stack advances exactly
      // 0.6em, so the per-column advance in device pixels is 0.6*size*dpr.
      // A fractional advance rasterizes each glyph at a different sub-pixel
      // phase, which paints visible vertical seams through solid block runs
      // (the "striped/tiled glyphs" on phones). Snapping the advance to a
      // half device pixel makes all columns tile with one consistent phase,
      // so block runs render as one solid surface at every DPR.
      const dpr = window.devicePixelRatio || 1;
      if (w > 0 && dpr > 0) {
        const widthAt = (s: number) => (w * s) / cap; // monospace: linear
        const sizeFor = (advDev: number) => advDev / (0.6 * dpr);
        const cur = 0.6 * size * dpr;
        let adv = Math.floor(cur * 2) / 2;
        const up = Math.ceil(cur * 2) / 2;
        if (up !== adv && sizeFor(up) <= cap && widthAt(sizeFor(up)) <= avail) adv = up;
        const snapped = sizeFor(adv);
        // snapped may exceed the fudge-shrunk `size` (the fudge reserves 2%
        // slack a snapped size doesn't need) - what matters is the container
        // fits and the cap is respected, never which was computed first.
        if (snapped >= floor && widthAt(snapped) <= avail) size = snapped;
      }
      el.style.fontSize = `${size}px`;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(parent);
    // box glyphs arrive with the webfont - refit once metrics are final
    document.fonts?.ready.then(fit).catch(() => undefined);
    return () => ro.disconnect();
  }, [cap, floor]);
  return ref;
}

export function Logo({ className }: { className?: string }) {
  const ref = useWordmarkFit<HTMLPreElement>();
  return (
    <pre
      ref={ref}
      style={{ fontSize: 18.3678 }}
      className={cn(
        // NO text-center here, ever: text-align centers each LINE
        // individually, and trailing spaces hang - so rows with more
        // trailing space (the shadow rows) drifted right off the character
        // grid (the "shifted bottom shadows" bug). The pre is centered as a
        // BLOCK via mx-auto w-fit; lines must stay flush-left on the grid.
        "ascii glow select-none text-neutral-100",
        "mx-auto w-fit max-w-full",
        // z-[93]: paint above the CRT scanline layer (z-90) - see SupplyLogo
        "relative z-[93]",
        className,
      )}
    >
      {ASCII_LOGO.trimEnd()}
      <WordmarkCoin />
    </pre>
  );
}

/* -- Supply progress logo ---------------------------------------------------
 * The big WEBQUID wordmark doubling as a live supply progress bar. The fill
 * flows LETTER BY LETTER through the word: the W pours full first (top to
 * bottom in grid order), then the E, then B, Q, U, I, D - one whole glyph
 * at a time, never a row-major horizontal curtain. Ink already mined
 * renders bright (the original wordmark look), ink still waiting renders
 * dim, and the glyph at the mining edge blinks like a terminal cursor
 * (steady under prefers-reduced-motion via the global .blink rule). The
 * fill plan (letter spans, per-character ranks) is pure and lives in
 * lib/logo-fill; progress is computed by the caller from the chain's own
 * totalSupply meta - never hardcoded.
 *
 * Opening ceremony: on a FRESH boot (the layout's splash fires wqd.booted
 * exactly once per session) the letters fill 0% -> 100% like a progress
 * bar, then ease back to the real mined fraction - 2 seconds total, pinned
 * in lib/bootfill. Restored sessions and motion-sensitive users see the
 * truth directly, no sweep.
 */
export function SupplyLogo({
  supply,
  softCap,
  className,
}: {
  supply: number; // base units
  softCap: number; // base units
  className?: string;
}) {
  const logo = ASCII_LOGO.trimEnd();
  const fitRef = useWordmarkFit<HTMLPreElement>();
  const real = softCap > 0 ? Math.min(1, Math.max(0, supply / softCap)) : 0;
  // non-null while the opening sweep is running; null = show the real fill
  const [sweep, setSweep] = useState<number | null>(null);
  const realRef = useRef(real);
  useEffect(() => {
    realRef.current = real;
  }, [real]);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (sessionStorage.getItem("wqd.booted") === "1") return; // restored session
    let raf = 0;
    const start = () => {
      const t0 = performance.now();
      const tick = (now: number) => {
        const t = now - t0;
        if (t >= BOOT_SWEEP_MS) {
          setSweep(null); // hand back to the real mined fraction
          return;
        }
        setSweep(bootSweepFillAt(t, realRef.current));
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    };
    window.addEventListener("wqd.booted", start);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("wqd.booted", start);
    };
  }, []);

  const progress = sweep ?? real;

  // letter-by-letter boundary: the fill plan ranks every ink character in
  // word order, so floor(progress * inkTotal) lands inside the glyph that
  // is currently pouring full - earlier glyphs complete, later ones dark
  const brightInk = Math.floor(progress * LOGO_FILL_PLAN.inkTotal);
  const runs = fillRuns(logo, LOGO_FILL_PLAN, brightInk);
  const pct = progress * 100;
  const pctText = pct === 0 ? "0" : pct.toFixed(2).replace(/\.?0+$/, "");
  // mined count grouped with the same thousands separators as the final
  // total, so the pair reads as one notation (4,200,000 / 10,500,025)
  // denominator rounds like EMISSION_TOTAL_COINS / the Terminal stat:
  // the curve total is a fractional-coin sum of floored block rewards,
  // and flooring it again here under-reports the final supply by one.
  const tip = `MINED: ${fmtInt(supply / COIN)} / ${fmtInt(Math.round(softCap / COIN))} WQD (${pctText}%)`;

  return (
    // z-[93]: paint the wordmark ABOVE the global CRT scanline overlay
    // (z-90). The global overlay's bands sit at fixed viewport offsets with
    // no relation to the glyph grid, and at phone sizes the fine box-drawing
    // strokes are 1-2 device px thin - fixed bands sliced them into ragged
    // dashes (the broken "shadows" under the glyphs). The wordmark instead
    // gets its OWN scoped scanline layer (.crt-wordmark below): same CRT
    // texture, but painted only over the wordmark, on top of ink already
    // snapped to the device-pixel grid by useWordmarkFit. Vignette (91)
    // still passes over it.
    <div className="group relative z-[93] mx-auto w-full max-w-full" tabIndex={0} aria-label={tip}>
      <pre
        ref={fitRef}
        data-testid="supply-logo"
        data-progress={progress}
        style={{ fontSize: 18.3678 }}
        className={cn(
          // NO text-center: it centers each line individually and trailing
          // spaces hang, pushing shadow rows right off the grid (see Logo).
          "ascii glow select-none text-neutral-100",
          // relative: the coin tittle is absolutely placed on this grid
          "relative",
          // Sized by useWordmarkFit (measure-then-shrink), NOT by a vw clamp:
          // viewport units ignore container padding and Android text scaling
          // inflates font-size without inflating vw - both left the wordmark
          // overflowing narrow phones. No overflow property here either:
          // overflow-x:hidden computes overflow-y to auto, which paints a
          // stray scrollbar next to the wordmark on mobile.
          "mx-auto w-fit max-w-full",
          className,
        )}
      >
        {runs.map((run, i) =>
          run.cls === "bright" ? (
            <Fragment key={i}>{run.text}</Fragment>
          ) : run.cls === "cursor" ? (
            <span key={i} data-testid="supply-cursor" className="blink">
              {run.text}
            </span>
          ) : (
            <span key={i} className="text-neutral-400 [text-shadow:none]">
              {run.text}
            </span>
          ),
        )}
        {/* The I's coin tittle follows the same supply split: it lights up
            when the letter-by-letter fill reaches the I glyph (COIN_INK_AT),
            dim before - same rule as the wordmark's own characters. */}
        <WordmarkCoin lit={brightInk > COIN_INK_AT} />
      </pre>
      {/* Scoped CRT scanline texture: the wordmark paints above the global
          scanline overlay (z-90), so without this layer it looked flat. The
          bands only darken glyph ink - over the black background they are
          invisible. Static by design: any animated texture reads as
          flicker on some screens. */}
      <div aria-hidden="true" className="crt-wordmark" />
      {/* terminal-styled tooltip: hover AND keyboard focus.
          top-full mt-1 - ALWAYS below the wordmark: above it, the tooltip's
          top tucks under the sticky topbar (z-94 paints above the hero) and
          gets cropped; below the wordmark nothing opaque is in the way. It
          transiently covers the first tagline - pointer-events-none, gone on
          blur. Never bottom-full again: any overlap with the pre covers the
          top glyph row (the pre's first line is the empty leading-newline
          row, so even a small negative margin touches ink on phones).
          No whitespace-nowrap: the full MINED line is ~44 chars (~400px),
          wider than a 360px phone - nowrap spilled it past BOTH viewport
          edges. w-max + max-w-[calc(100vw-1rem)] shrinks to content but
          never past the viewport, wrapping to two centered lines instead. */}
      <div
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-full z-50 mt-1 w-max max-w-[calc(100vw-1rem)] -translate-x-1/2 border border-neutral-600 bg-black px-3 py-1.5 text-center text-[clamp(12px,3.4vw,15px)] font-semibold tracking-[0.15em] text-white opacity-0 transition-opacity [overflow-wrap:anywhere] [text-shadow:0_0_6px_rgba(255,255,255,0.45)] group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {tip}
      </div>
    </div>
  );
}

/* -- Divider with label --------------------------------------------------- */
export function Divider({ label }: { label?: string }) {
  return (
    <div className="my-4 flex items-center gap-3 text-neutral-600">
      <span className="h-px flex-1 bg-neutral-800" />
      {label ? (
        <span className="text-[10px] uppercase tracking-[0.3em]">{label}</span>
      ) : null}
      <span className="h-px flex-1 bg-neutral-800" />
    </div>
  );
}
