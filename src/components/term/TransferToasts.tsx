/**
 * Transfer popups - the UPDATING window's little siblings. When money
 * MOVES (an incoming transfer confirms to this wallet, or a transfer this
 * node broadcast lands in a block) a bordered phosphor window pops up at
 * the bottom-right and the notification center fires the event's sound
 * cue in the same tick (received = ascending ping, confirmed = descending
 * blip). The window NEVER leaves on its own: the only way out is the
 * corner X, pressed by the user. The bell panel keeps the permanent
 * record; these windows are the "look up NOW" layer.
 *
 * Behavior contract (the rules themselves live in lib/toast-policy.ts):
 *   - ONLY money events pop: transaction_received + transfer_confirmed.
 *   - NEVER REPLAYS: entries already in the store when the component
 *     mounts (restored from localStorage) are marked seen, not popped -
 *     a reload must not re-announce old money.
 *   - NEVER TIMES OUT: no auto-dismiss countdown, no Escape shortcut -
 *     the corner X is the single, explicit dismissal path.
 *   - NON-MODAL: the stack container swallows no clicks; only the windows
 *     themselves are interactive.
 *   - BOUNDED: at most MAX_VISIBLE_POPUPS windows at once; a further
 *     arrival retires the oldest early (its entry is still in the bell).
 *   - The entrance animation is transform+opacity only and skipped for
 *     reduced-motion users.
 */
import { useEffect, useState } from "react";
import {
  getNotifications,
  ICONS,
  subscribeNotifications,
  type AppNotification,
} from "@/lib/notify";
import {
  capPopupStack,
  freshPopupItems,
  MAX_VISIBLE_POPUPS,
  parseMoneyMessage,
} from "@/lib/toast-policy";
import { BrandCoin } from "@/components/term/ui";
import { cn } from "@/lib/utils";

/**
 * One popup window. Pure presentation + the corner X; there is
 * deliberately no timer and no keyboard shortcut here - the user asked
 * for a window that stays until THEY close it.
 *
 * Layout: a title bar (the spinning brand coin - one flip every 3s - plus
 * the glowing event headline), then the money payload typeset BIG: the
 * signed amount as the hero line, the sender and the block number as
 * labelled rows. Money IN carries the design system's one sanctioned
 * accent (the badge's muted green); a settled send stays phosphor white.
 * Every long value is break-all inside the fixed-width window, so no
 * address can ever distort the card.
 */
function ToastCard({ n, onClose }: { n: AppNotification; onClose: () => void }) {
  const money = parseMoneyMessage(n.type, n.message);
  const incoming = n.type === "transaction_received";
  return (
    <div
      role="alert"
      data-testid="transfer-toast"
      data-type={n.type}
      className="wqd-toast-in pointer-events-auto relative w-full border border-neutral-600 bg-black font-term shadow-[0_0_50px_rgba(255,255,255,0.10)]"
    >
      {/* corner X - the ONLY dismiss path; keyboard focusable, and
          hover-inverts like every terminal button */}
      <button
        type="button"
        aria-label="Dismiss notification"
        data-testid="transfer-toast-close"
        onClick={onClose}
        className="absolute right-1 top-1 z-10 px-1.5 py-0.5 text-xs font-bold leading-none tracking-normal text-neutral-500 hover:bg-neutral-200 hover:text-black"
      >
        [X]
      </button>
      {/* title bar: coin + headline; pr-9 keeps the headline clear of the X */}
      <div className="flex items-center gap-2.5 border-b border-neutral-800 px-3.5 py-2.5 pr-9">
        <BrandCoin className="text-[15px]" />
        <p className="text-[15px] font-bold tracking-[0.22em] text-white [text-shadow:0_0_10px_rgba(255,255,255,0.5)]">
          {ICONS[n.type]} {n.title}
        </p>
      </div>
      {money ? (
        <div className="px-3.5 pb-2.5 pt-2.5">
          {/* the hero line: signed amount, one step under the window's max
              width even for whale-sized figures (break-all) */}
          <p
            data-testid="toast-amount"
            className={cn(
              "break-all text-[24px] font-bold leading-none tracking-[0.06em]",
              incoming
                ? "text-[#8fb98f] [text-shadow:0_0_12px_rgba(122,154,122,0.65)]"
                : "text-white [text-shadow:0_0_10px_rgba(255,255,255,0.5)]",
            )}
          >
            {incoming ? "+" : "-"}{money.amount} WQD
          </p>
          <dl className="mt-2 space-y-1">
            {money.counterparty ? (
              <div className="flex items-baseline gap-2.5">
                <dt className="w-12 flex-none text-[10px] uppercase tracking-[0.2em] text-neutral-500">
                  from
                </dt>
                <dd
                  data-testid="toast-row"
                  className="min-w-0 break-all text-[15px] leading-snug tracking-[0.04em] text-neutral-200"
                >
                  {money.counterparty}
                </dd>
              </div>
            ) : null}
            <div className="flex items-baseline gap-2.5">
              <dt className="w-12 flex-none text-[10px] uppercase tracking-[0.2em] text-neutral-500">
                block
              </dt>
              <dd
                data-testid="toast-row"
                className="min-w-0 break-all text-[15px] leading-snug tracking-[0.04em] text-neutral-200"
              >
                #{money.block}
              </dd>
            </div>
          </dl>
        </div>
      ) : (
        /* unparseable payload (older phrasing, seeded entries) - the raw
           message, still one step larger than body text */
        <p className="break-words px-3.5 pb-2.5 pt-2.5 text-[15px] leading-snug tracking-[0.06em] text-neutral-200">
          {n.message}
        </p>
      )}
      <div className="mx-3.5 mb-2 mt-1 border-t border-dashed border-neutral-800 pt-1.5 text-[9px] leading-relaxed tracking-[0.14em] text-neutral-600">
        SAVED IN NOTIFICATIONS - [X] TO DISMISS<span className="blink">_</span>
      </div>
    </div>
  );
}

export function TransferToasts() {
  const [popups, setPopups] = useState<AppNotification[]>([]);

  /**
   * Direct store subscription (the lint-clean alternative to deriving
   * state from useSyncExternalStore in an effect): the baseline is every
   * id the store holds at mount - entries restored from localStorage are
   * old news and must never pop after a reload - and from then on each
   * emit diffs the snapshot against the ids already accounted for. The
   * setState call lives inside the store's own emit callback, exactly
   * where React wants external-system updates. EVERY new id is added to
   * the baseline - popup-worthy or not - so a silent type can never pop
   * later just because it arrived before we looked.
   */
  useEffect(() => {
    const seen = new Set(getNotifications().map((n) => n.id));
    return subscribeNotifications(() => {
      const items = getNotifications();
      const fresh = freshPopupItems(items, seen);
      for (const n of items) seen.add(n.id);
      if (fresh.length > 0) {
        setPopups((stack) => capPopupStack([...stack, ...fresh], MAX_VISIBLE_POPUPS));
      }
    });
  }, []);

  if (popups.length === 0) return null;
  return (
    // z-[95]: below the chain-update window (96) and the boot screen
    // (100) - while the system is passive those own the screen - above
    // the header (94), the wordmark (93) and the CRT layers (90-92).
    <div
      data-testid="transfer-toast-stack"
      className="pointer-events-none fixed bottom-[calc(0.75rem+env(safe-area-inset-bottom))] right-2 z-[95] flex w-[calc(100vw-1rem)] max-w-sm flex-col gap-2 min-[480px]:right-3"
    >
      {popups.map((n) => (
        <ToastCard
          key={n.id}
          n={n}
          onClose={() => setPopups((stack) => stack.filter((p) => p.id !== n.id))}
        />
      ))}
    </div>
  );
}
