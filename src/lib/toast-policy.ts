/**
 * Transfer popup policy - the pure decisions behind the TransferToasts
 * component (which notifications earn a popup window, how the stack is
 * bounded, how long a window lives). Kept component-free so the rules are
 * unit-testable without a DOM and so fast-refresh stays clean.
 */
import type { AppNotification, NotificationType } from "./notify";

/**
 * The only two notification types that earn a popup window: money IN
 * (an incoming transfer confirmed to this wallet) and money SETTLED
 * (a transfer this node broadcast landed in a block). Everything else
 * (peers, mining churn, reminders, errors) stays in the bell - a busy
 * mesh must never strobe windows across the screen.
 */
export const POPUP_TYPES: readonly NotificationType[] = [
  "transaction_received",
  "transfer_confirmed",
];

/** At most this many windows stacked at once - newest survive. */
export const MAX_VISIBLE_POPUPS = 3;

/**
 * NO auto-dismiss: there is deliberately no timeout constant here. A
 * money popup stays on screen until the user presses its corner X - an
 * unattended terminal may collect up to MAX_VISIBLE_POPUPS windows, and
 * the bell panel always keeps the full record.
 */

/**
 * The pop decision: given the store snapshot and the ids already
 * accounted for, which entries are BOTH unseen AND popup-worthy?
 * Arrival order is kept so windows stack oldest-first.
 */
export function freshPopupItems(
  items: readonly AppNotification[],
  seen: ReadonlySet<string>,
): AppNotification[] {
  const out: AppNotification[] = [];
  for (const n of items) {
    if (seen.has(n.id)) continue;
    if (POPUP_TYPES.includes(n.type)) out.push(n);
  }
  return out;
}

/** Cap a window stack at max; when it overflows, the NEWEST windows stay. */
export function capPopupStack<T>(stack: readonly T[], max: number): T[] {
  return stack.length <= max ? [...stack] : stack.slice(stack.length - max);
}

// -- structured money payload -----------------------------------------------------

/**
 * The parsed payload of a money popup, lifted out of the notification's
 * prose message so the window can typeset it: big glowing amount line,
 * labelled FROM/BLOCK rows. The messages are produced by
 * useFeedbackWatcher in exactly two shapes:
 *   received:  "Received 12.5 WQD from wqd1alice...9f2c. Block #1,234"
 *   confirmed: "Sent 3 WQD. Block #1,235"
 * Anything else (older phrasing, hand-seeded entries) parses to null and
 * the window falls back to the raw message line - never to a broken card.
 */
export interface MoneyPopupFields {
  /** "in" = coins arrived, "out" = our broadcast settled. */
  direction: "in" | "out";
  /** The bare amount figure, locale-formatted, no unit: "12.5". */
  amount: string;
  /** Shortened sender for incoming transfers; null for confirmed sends. */
  counterparty: string | null;
  /** Locale-formatted block height without the "#": "1,234". */
  block: string;
}

const RECEIVED_RE = /^Received ([\d,]+(?:\.\d+)?) WQD from (.+)\. Block #([\d,]+)$/;
const CONFIRMED_RE = /^Sent ([\d,]+(?:\.\d+)?) WQD\. Block #([\d,]+)$/;

export function parseMoneyMessage(
  type: NotificationType,
  message: string,
): MoneyPopupFields | null {
  if (type === "transaction_received") {
    const m = RECEIVED_RE.exec(message);
    if (!m) return null;
    return { direction: "in", amount: m[1], counterparty: m[2], block: m[3] };
  }
  if (type === "transfer_confirmed") {
    const m = CONFIRMED_RE.exec(message);
    if (!m) return null;
    return { direction: "out", amount: m[1], counterparty: null, block: m[2] };
  }
  return null;
}
