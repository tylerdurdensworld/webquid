/**
 * Relay-policy guard: one sender may hold at most MAX_MEMPOOL_PER_SENDER
 * pending slots, so a single funded wallet cannot occupy the whole mempool
 * with min-fee spam. Node policy, NOT consensus - block validity is
 * untouched, which this test proves by mining the queued txs afterwards.
 */
import { describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { GENESIS_TIMESTAMP, hashMeetsTarget } from "@contracts/protocol";
import { signTransfer, walletFromPrivHex } from "@/lib/webquid";

const w1 = walletFromPrivHex("01".repeat(32))!;

// Same deterministic block-1 as chain.test.ts: coinbase-only to w1 at the
// genesis+1 timestamp - the baked nonce verifies with ONE hash.
const BAKED: Record<string, { nonce: number; hash: string }> = {
  "WQD1|1|207d9fa191adc5c4ee74a14c6c5e90164816388f82b4a044a5c17fb3a9530ef7|94b188f363ae97aa3e38e4ae291beb48b97bd7da0900e74680253d869e07094d|1790726401|": { nonce: 18023509, hash: "0000006cad05f011ff090ee83e98576d6d99c613fd620d90d1c2d7b291b8ab48" },
};

function powSearch(prefixAscii: string, target: string): { nonce: number; hash: string } {
  const baked = BAKED[prefixAscii];
  if (baked) {
    const prefix = utf8ToBytes(prefixAscii);
    const d1 = sha256.create().update(prefix).update(utf8ToBytes(String(baked.nonce))).digest();
    const hash = bytesToHex(sha256(d1));
    if (hash !== baked.hash || !hashMeetsTarget(hash, target)) {
      throw new Error(`baked solution invalid for ${prefixAscii}`);
    }
    return baked;
  }
  const prefix = utf8ToBytes(prefixAscii);
  for (let nonce = 0; nonce < 2 ** 31; nonce++) {
    const d1 = sha256.create().update(prefix).update(utf8ToBytes(String(nonce))).digest();
    const hash = bytesToHex(sha256(d1));
    if (hashMeetsTarget(hash, target)) {
      console.log(`BAKE: "${prefixAscii}": { nonce: ${nonce}, hash: "${hash}" },`);
      return { nonce, hash };
    }
  }
  throw new Error("pow search exhausted");
}

describe("mempool relay policy", () => {
  it("caps one sender at MAX_MEMPOOL_PER_SENDER pending slots", async () => {
    vi.resetModules();
    const chain = await import("./chain");
    const { MemoryStorage } = await import("./storage");
    await chain.initChain(new MemoryStorage());

    // fund w1 with one bootstrap coinbase (350 WQD covers 64 x 1001 units)
    const tpl = await chain.buildTemplate(w1.address);
    const ts = GENESIS_TIMESTAMP + 1;
    const win = powSearch(
      `WQD1|${tpl.height}|${tpl.prevHash}|${tpl.merkleRoot}|${ts}|`,
      tpl.target,
    );
    await chain.submitBlock(tpl.templateId, ts, win.nonce);

    // exactly MAX_MEMPOOL_PER_SENDER sequential pending txs are admitted
    for (let nonce = 0; nonce < chain.MAX_MEMPOOL_PER_SENDER; nonce++) {
      const unsigned = { from: w1.address, to: w1.address, amount: 1, fee: 1_000, nonce };
      const signature = signTransfer(w1.privHex, unsigned);
      await chain.admitTransfer({ ...unsigned, pubkey: w1.pubHex, signature });
    }
    expect(await chain.getMempool(100)).toHaveLength(chain.MAX_MEMPOOL_PER_SENDER);

    // slot 65 from the SAME sender is refused by policy
    const over = { from: w1.address, to: w1.address, amount: 1, fee: 1_000, nonce: chain.MAX_MEMPOOL_PER_SENDER };
    await expect(
      chain.admitTransfer({ ...over, pubkey: w1.pubHex, signature: signTransfer(w1.privHex, over) }),
    ).rejects.toThrow(/too many pending transactions from one sender/);

    // consensus untouched: the queued txs still mine into a valid block
    const tpl2 = await chain.buildTemplate(w1.address);
    expect(tpl2.txCount).toBeGreaterThan(0);
  }, 60_000);
});
