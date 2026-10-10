/**
 * Transfer popup policy tests - which notifications earn a window, how
 * the stack is bounded, and the lifetime/motion constants. The
 * TransferToasts component is a thin React shell over these decisions.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  capPopupStack,
  freshPopupItems,
  MAX_VISIBLE_POPUPS,
  parseMoneyMessage,
  POPUP_TYPES,
} from "./toast-policy";
import * as policy from "./toast-policy";
import type { AppNotification, NotificationType } from "./notify";

const CSS = fileURLToPath(new URL("../index.css", import.meta.url));

function mk(type: NotificationType, id: string, at = 1_700_000_000_000): AppNotification {
  return { id, type, title: type.toUpperCase(), message: `msg ${id}`, at, read: false };
}

describe("freshPopupItems", () => {
  it("pops exactly the two money events: received + confirmed", () => {
    const items = [
      mk("transaction_received", "a1"),
      mk("transfer_confirmed", "a2"),
      mk("pop_reward", "a3"),
      mk("block_found", "a4"),
      mk("system", "a5"),
      mk("error", "a6"),
      mk("peer_connected", "a7"),
      mk("mining_start", "a8"),
      mk("backup_reminder", "a9"),
      mk("mining_stop", "a10"),
    ];
    expect(freshPopupItems(items, new Set()).map((n) => n.id)).toEqual(["a1", "a2"]);
  });

  it("skips ids already accounted for (no replay after reload)", () => {
    const items = [mk("transaction_received", "a1"), mk("transfer_confirmed", "a2")];
    expect(freshPopupItems(items, new Set(["a1", "a2"]))).toEqual([]);
    expect(freshPopupItems(items, new Set(["a1"])).map((n) => n.id)).toEqual(["a2"]);
  });

  it("keeps arrival order so windows stack oldest-first", () => {
    const items = [
      mk("transfer_confirmed", "x1"),
      mk("transaction_received", "x2"),
      mk("transaction_received", "x3"),
    ];
    expect(freshPopupItems(items, new Set()).map((n) => n.id)).toEqual(["x1", "x2", "x3"]);
  });

  it("POPUP_TYPES is exactly the two money events - no silent creep", () => {
    expect([...POPUP_TYPES].sort()).toEqual(["transaction_received", "transfer_confirmed"]);
  });
});

describe("capPopupStack", () => {
  it("leaves stacks at or under the cap untouched (order preserved)", () => {
    expect(capPopupStack([1, 2, 3], 3)).toEqual([1, 2, 3]);
    expect(capPopupStack([1], 3)).toEqual([1]);
    expect(capPopupStack([], 3)).toEqual([]);
  });

  it("overflow retires the OLDEST windows, newest survive", () => {
    expect(capPopupStack([1, 2, 3, 4], 3)).toEqual([2, 3, 4]);
    expect(capPopupStack([1, 2, 3, 4, 5], 3)).toEqual([3, 4, 5]);
  });

  it("the cap is 3 - one busy burst never papers the screen", () => {
    expect(MAX_VISIBLE_POPUPS).toBe(3);
  });
});

describe("popup lifetime and motion", () => {
  it("NO auto-dismiss: the policy exports no timeout - only the corner X closes a window", () => {
    // user requirement, pinned: a money popup never leaves on its own
    expect("POPUP_TIMEOUT_MS" in policy).toBe(false);
  });

  it("entrance animation is transform+opacity only and reduced-motion gated", () => {
    const css = readFileSync(CSS, "utf8");
    const gate = css.match(
      /@media \(prefers-reduced-motion: no-preference\) \{([\s\S]*?)\n {2}\}/g,
    );
    expect(gate).not.toBeNull();
    expect(gate!.some((block) => block.includes(".wqd-toast-in"))).toBe(true);
    const frames = css.match(/@keyframes wqd-toast-in \{([\s\S]*?)\n {2}\}/);
    expect(frames).not.toBeNull();
    // compositor-only properties - no layout/paint thrash on arrival
    expect(frames![1]).not.toMatch(/top|left|width|height|margin|padding/);
    expect(frames![1]).toContain("transform");
    expect(frames![1]).toContain("opacity");
  });
});

describe("parseMoneyMessage", () => {
  it("parses the received shape: amount + sender + block", () => {
    const f = parseMoneyMessage(
      "transaction_received",
      "Received 12.5 WQD from wqd1alice...9f2c. Block #1,234",
    );
    expect(f).toEqual({
      direction: "in",
      amount: "12.5",
      counterparty: "wqd1alice...9f2c",
      block: "1,234",
    });
  });

  it("parses the confirmed shape: amount + block, no counterparty", () => {
    const f = parseMoneyMessage("transfer_confirmed", "Sent 3 WQD. Block #1,235");
    expect(f).toEqual({ direction: "out", amount: "3", counterparty: null, block: "1,235" });
  });

  it("handles whale amounts, long addresses and big heights", () => {
    const f = parseMoneyMessage(
      "transaction_received",
      "Received 999,999,999.00000001 WQD from wqd1qqqqqqqqqqqqqqqqqqqq...zzzzzz. Block #12,345,678",
    );
    expect(f?.amount).toBe("999,999,999.00000001");
    expect(f?.counterparty).toBe("wqd1qqqqqqqqqqqqqqqqqqqq...zzzzzz");
    expect(f?.block).toBe("12,345,678");
  });

  it("unknown phrasing parses to null so the card falls back to the raw line", () => {
    expect(parseMoneyMessage("transaction_received", "burst 1 WQD. Block #2,001")).toBeNull();
    expect(parseMoneyMessage("transfer_confirmed", "Sent 3 WQD to wqd1x. Height 9")).toBeNull();
    expect(parseMoneyMessage("transaction_received", "")).toBeNull();
  });

  it("silent types never parse - they never reach a popup anyway", () => {
    expect(parseMoneyMessage("system", "Received 5 WQD from wqd1x. Block #1")).toBeNull();
    expect(parseMoneyMessage("pop_reward", "Sent 5 WQD. Block #1")).toBeNull();
  });
});

describe("popup brand coin", () => {
  it("the coin flips once every 3s on a dedicated keyframe, transform-only and reduced-motion gated", () => {
    const css = readFileSync(CSS, "utf8");
    // the gate: .wqd-brandcoin's spin runs on the 3s loop
    const gate = css.match(
      /@media \(prefers-reduced-motion: no-preference\) \{([\s\S]*?)\n {2}\}/g,
    );
    expect(gate).not.toBeNull();
    const coinGate = gate!.find((block) => block.includes(".wqd-brandcoin"));
    expect(coinGate).toBeDefined();
    expect(coinGate).toContain("wqd-coin-flip-3s 3s");
    // the keyframe: rotateY only - no layout or paint properties, so the
    // system idles between flips even with a full stack of popups
    const frames = css.match(/@keyframes wqd-coin-flip-3s \{([\s\S]*?)\n {2}\}/);
    expect(frames).not.toBeNull();
    expect(frames![1]).not.toMatch(/top|left|width|height|margin|padding|filter|opacity/);
    expect(frames![1]).toContain("rotateY(0deg)");
    expect(frames![1]).toContain("rotateY(360deg)");
  });

  it("the coin box is em-sized and never a positioning hazard (static flow, flex-none)", () => {
    const css = readFileSync(CSS, "utf8");
    const box = css.match(/\.wqd-brandcoin \{([\s\S]*?)\n {2}\}/);
    expect(box).not.toBeNull();
    expect(box![1]).toContain("width: 2em");
    expect(box![1]).toContain("height: 2em");
    expect(box![1]).toContain("flex: none");
  });
});
