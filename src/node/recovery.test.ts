/**
 * Boot recovery - the balances table is derived state. If it is ever lost
 * while the blocks survive (partial storage eviction, profile damage), the
 * node must rebuild it: replaying from genesis, or from the latest local
 * state snapshot when one exists. Real PoW, memory adapter, one continuous
 * narrative (the chain module binds one storage per process).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { hashMeetsTarget } from "@contracts/protocol";
import { walletFromPrivHex } from "@/lib/webquid";
import {
  buildTemplate,
  getAddressOverview,
  getInfo,
  initChain,
  recoverChainState,
  submitBlock,
} from "./chain";
import { MemoryStorage } from "./storage";

// Baked PoW solutions (deterministic narrative: fixed keys, synthetic
// timestamps) - verified with ONE hash each; the live search only grinds
// when the narrative changes (and prints fresh solutions to bake).
const BAKED: Record<string, { nonce: number; hash: string }> = {
  "WQD1|1|207d9fa191adc5c4ee74a14c6c5e90164816388f82b4a044a5c17fb3a9530ef7|f10dd540bc11cc75e2a3ec504ca7e8638993c7af15551592838d75bea9fcfda9|1790726401|": { nonce: 594034, hash: "00000350715a7067df76ebf7aaec96b06f6ac95c840eeef00192366ddca89302" },
  "WQD1|2|00000350715a7067df76ebf7aaec96b06f6ac95c840eeef00192366ddca89302|27bbe0aa2e24a61bfe3eefa0daa6f0ff2dee91288f7ef0b3951b99e56310f636|1790726402|": { nonce: 2137703, hash: "000001e38e8131175952c61a11032015a27158d2fa73a48a8e61b966e86ab3ed" },
  "WQD1|3|000001e38e8131175952c61a11032015a27158d2fa73a48a8e61b966e86ab3ed|1c31024e4e31604ba1c48b7411fde95323c720b98d1ef34612503899a9dbd31c|1790726403|": { nonce: 3097267, hash: "000003b4f7f2df363999b9233d251f6b419b1771c124f608fe8317aa09f91aed" },
  "WQD1|4|000003b4f7f2df363999b9233d251f6b419b1771c124f608fe8317aa09f91aed|d8aafdd5a22cfeeecfc2893b4b3710a62b2dfaa8a6db4cd6a2cabfd3bb5b0979|1790726404|": { nonce: 7115394, hash: "000001252710ae18745fc52e77e5faad6b48d7a1de582e08f0074692cd4ab5ee" },
};

function pow(prefixAscii: string, target: string): { nonce: number; hash: string } {
  const baked = BAKED[prefixAscii];
  const prefix = utf8ToBytes(prefixAscii);
  if (baked) {
    const d1 = sha256.create().update(prefix).update(utf8ToBytes(String(baked.nonce))).digest();
    const hash = bytesToHex(sha256(d1));
    if (hash !== baked.hash || !hashMeetsTarget(hash, target)) {
      throw new Error(`baked solution invalid for ${prefixAscii}`);
    }
    return baked;
  }
  for (let nonce = 0; nonce < 2 ** 31; nonce++) {
    const d1 = sha256.create().update(prefix).update(utf8ToBytes(String(nonce))).digest();
    const hash = bytesToHex(sha256(d1));
    if (hashMeetsTarget(hash, target)) {
      console.log(`BAKE: "${prefixAscii}": { nonce: ${nonce}, hash: "${hash}" },`);
      return { nonce, hash };
    }
  }
  throw new Error("nonce space exhausted");
}

async function mineNext(miner: string): Promise<void> {
  const tpl = await buildTemplate(miner);
  const ts = tpl.minTimestamp; // synthetic - deterministic narrative
  const { nonce } = pow(
    `WQD1|${tpl.height}|${tpl.prevHash}|${tpl.merkleRoot}|${ts}|`,
    tpl.target,
  );
  await submitBlock(tpl.templateId, ts, nonce);
}

/** Simulate the disaster: every account zeroed (balances sum != supply). */
async function wipeBalances(storage: MemoryStorage): Promise<void> {
  await storage.transact(async (tx) => {
    for (const acc of await tx.allAccounts()) {
      await tx.putAccount({ ...acc, balance: 0 });
    }
  });
}

describe("boot state recovery", () => {
  const storage = new MemoryStorage();
  const minerA = walletFromPrivHex("aa".repeat(32))!;
  const minerB = walletFromPrivHex("bb".repeat(32))!;

  beforeAll(async () => {
    await initChain(storage);
    await mineNext(minerA.address); // block 1
    await mineNext(minerA.address); // block 2
  }, 120_000);

  it("rebuilds lost balances by replaying blocks from genesis", async () => {
    const before = await getAddressOverview(minerA.address);
    const supplyBefore = (await getInfo()).totalSupply;
    expect(before.balance).toBeGreaterThan(0);

    await wipeBalances(storage);
    await recoverChainState();

    const after = await getAddressOverview(minerA.address);
    expect(after.balance).toBe(before.balance);
    expect((await getInfo()).totalSupply).toBe(supplyBefore);
  });

  /** The supply the BLOCKS themselves imply: sum(reward + pop - fees). */
  async function blockImpliedSupply(): Promise<number> {
    const tip = (await storage.tip())!;
    let sum = 0;
    for (let h = 1; h <= tip.height; h++) {
      const b = (await storage.blockAt(h))!;
      sum += b.reward + b.popTransfers.reduce((x, p) => x + p.amount, 0) - b.feesBurned;
    }
    return sum;
  }

  it("a corrupted totalSupply meta heals back to the block-implied value", async () => {
    // Drift left behind by any historical version: the meta row no longer
    // matches the chain. Balances are INTACT - a rebuild must restore the
    // meta without touching (let alone double-crediting) a single balance.
    const expected = await blockImpliedSupply();
    expect((await getInfo()).totalSupply).toBe(expected);
    const balA = (await getAddressOverview(minerA.address)).balance;

    await storage.transact(async (tx) => {
      await tx.setMeta("totalSupply", String(expected + 12_345));
    });
    await recoverChainState();

    expect((await getInfo()).totalSupply).toBe(expected);
    expect((await getAddressOverview(minerA.address)).balance).toBe(balA);
  });

  it("a single corrupted balance heals, supply untouched", async () => {
    const expected = await blockImpliedSupply();
    const balA = (await getAddressOverview(minerA.address)).balance;

    await storage.transact(async (tx) => {
      const acc = (await tx.account(minerA.address))!;
      await tx.putAccount({ ...acc, balance: acc.balance + 1 });
    });
    await recoverChainState();

    expect((await getInfo()).totalSupply).toBe(expected);
    expect((await getAddressOverview(minerA.address)).balance).toBe(balA);
  });

  it("supply and balances drifted TOGETHER still heals (the old check missed this)", async () => {
    // The pre-fix invariant was only sum(balances) === totalSupply: drift
    // that moved BOTH caches by the same amount passed it and lived
    // forever - which is exactly how devices ended up showing different
    // supply for the same chain. The block-implied cross-check catches it.
    const expected = await blockImpliedSupply();
    const balA = (await getAddressOverview(minerA.address)).balance;

    await storage.transact(async (tx) => {
      const acc = (await tx.account(minerA.address))!;
      await tx.putAccount({ ...acc, balance: acc.balance + 777 });
      await tx.setMeta("totalSupply", String(expected + 777));
    });
    // sanity: the OLD invariant alone would call this state healthy
    const accounts = await storage.allAccounts();
    const held = accounts.reduce((s, a) => s + a.balance, 0);
    expect(held).toBe(expected + 777);

    await recoverChainState();

    expect((await getInfo()).totalSupply).toBe(expected);
    expect((await getAddressOverview(minerA.address)).balance).toBe(balA);
  });

  it("rebuilds from the latest snapshot even when early blocks are gone", async () => {
    // The exact row the SNAPSHOT_INTERVAL hook persists every 1,000 blocks.
    // NOTE: destructive (block 1 is deleted) - the checkpoint tests below
    // intentionally run on this post-disaster state.
    const tip2 = (await storage.tip())!;
    expect(tip2.height).toBe(2);
    const accountsAt2 = await storage.allAccounts();
    const supplyAt2 = Number((await storage.getMeta("totalSupply")) ?? "0");
    await storage.transact(async (tx) => {
      await tx.putSnapshot({
        height: tip2.height,
        blockHash: tip2.hash,
        totalSupply: supplyAt2,
        accounts: accountsAt2,
      });
    });

    await mineNext(minerB.address); // block 3
    const before = await getAddressOverview(minerB.address);
    const supplyBefore = (await getInfo()).totalSupply;
    expect(before.balance).toBeGreaterThan(0);

    // Worse disaster: balances wiped AND block 1 pruned away - replaying
    // from genesis is impossible; only the snapshot path can heal this.
    await storage.transact(async (tx) => {
      for (const acc of await tx.allAccounts()) {
        await tx.putAccount({ ...acc, balance: 0 });
      }
      await tx.deleteTxsInBlock(1);
      await tx.deleteBlock(1);
    });
    await recoverChainState();

    const afterA = await getAddressOverview(minerA.address);
    const afterB = await getAddressOverview(minerB.address);
    expect(afterB.balance).toBe(before.balance);
    expect(afterA.balance).toBe(supplyAt2); // snapshot state survived intact
    expect((await getInfo()).totalSupply).toBe(supplyBefore);
  }, 120_000);

  it("checkpoint fast path: a fully verified chain costs ZERO block reads on the next check", async () => {
    // The rebuild above pinned the checkpoint at the tip. A healthy re-check
    // must not touch the blocks store at all - boot stays O(1) no matter
    // how long the chain grows. (This is the boot-time regression guard.)
    const spy = vi.spyOn(storage, "blockAt");
    try {
      await recoverChainState();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    const cp = JSON.parse((await storage.getMeta("recoveryCheckpoint"))!);
    expect(cp.height).toBe((await storage.tip())!.height);
    expect(cp.expected).toBe((await getInfo()).totalSupply);
  });

  it("incremental scan: only blocks ABOVE the checkpoint are read", async () => {
    await mineNext(minerB.address); // block 4
    const spy = vi.spyOn(storage, "blockAt");
    try {
      await recoverChainState();
      expect(spy.mock.calls.map((c) => c[0])).toEqual([4]);
    } finally {
      spy.mockRestore();
    }
    // the checkpoint advanced to the new tip with the healed-true value
    const cp = JSON.parse((await storage.getMeta("recoveryCheckpoint"))!);
    expect(cp.height).toBe(4);
    expect(cp.expected).toBe((await getInfo()).totalSupply);
  });

  it("a garbage checkpoint meta falls back to a full scan and still boots healthy", async () => {
    // Corrupt the performance anchor itself: the node must simply pay one
    // full scan (and stay healthy - the derived caches here are intact).
    // Never trust the checkpoint format blindly.
    const validCp = (await storage.getMeta("recoveryCheckpoint")) ?? null;
    const supplyNow = (await getInfo()).totalSupply;
    await storage.transact(async (tx) => {
      await tx.setMeta("recoveryCheckpoint", "{definitely not json");
    });
    const spy = vi.spyOn(storage, "blockAt");
    try {
      await recoverChainState();
      const heights = spy.mock.calls.map((c) => c[0]);
      expect(heights).toContain(1); // full scan from genesis, not the fast path
    } finally {
      spy.mockRestore();
    }
    expect((await getInfo()).totalSupply).toBe(supplyNow); // untouched
    // restore the fast path for any later boots of this narrative
    if (validCp !== null) {
      await storage.transact(async (tx) => {
        await tx.setMeta("recoveryCheckpoint", validCp);
      });
    }
  });
});
