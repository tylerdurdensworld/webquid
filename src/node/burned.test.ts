/**
 * Total-burned counter - the number behind the Terminal page's
 * "BURNED FOREVER: %x" line. totalBurned is derived, never stored:
 *
 *     totalBurned = (sum of every block reward ever emitted) - totalSupply
 *
 * Rewards are a pure function of height, so the emission sum is exact on
 * every chain path - and the gap between emission and live supply is by
 * construction the split burn + rounding dust + unclaimed PoP + fees.
 * These tests pin that identity with real blocks, real fees, a rollback,
 * and a file import.
 */
import { describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { COIN, hashMeetsTarget } from "@contracts/protocol";
import { signTransfer, walletFromPrivHex } from "@/lib/webquid";
import { MemoryStorage } from "./storage";

const w1 = walletFromPrivHex("01".repeat(32))!;
const w2 = walletFromPrivHex("02".repeat(32))!;

// Deterministic PoW, coinbase-only chain paying w1 (same preimages as
// chain-gate.test.ts / import-safety.test.ts - searched once, baked).
const BAKED: Record<string, { nonce: number; hash: string }> = {
  "WQD1|1|207d9fa191adc5c4ee74a14c6c5e90164816388f82b4a044a5c17fb3a9530ef7|94b188f363ae97aa3e38e4ae291beb48b97bd7da0900e74680253d869e07094d|1790726401|": { nonce: 18023509, hash: "0000006cad05f011ff090ee83e98576d6d99c613fd620d90d1c2d7b291b8ab48" },
  "WQD1|2|0000006cad05f011ff090ee83e98576d6d99c613fd620d90d1c2d7b291b8ab48|614a8e6f2bdca9a6c249010ad93256f7fae6d5a647db7832e99fb7235e8200a8|1790726402|": { nonce: 2838971, hash: "00000258b5b575fe3eeaa587c09ef2a6c39d1200092c0d839599982c8aa5414d" },
  "WQD1|2|0000006cad05f011ff090ee83e98576d6d99c613fd620d90d1c2d7b291b8ab48|79b9d40475bdc649523a7db2631048e9cb509ac23f458d9a8507d24174ffa993|1790726402|": { nonce: 1038865, hash: "000000de8339e66e912c3fc2878778dc8cb2522bc8c921f1a159b798af9882ef" },
  "WQD1|3|00000258b5b575fe3eeaa587c09ef2a6c39d1200092c0d839599982c8aa5414d|998b82684c9cdbbf875774531a8ff85e359de44c01061dbaab0ba1e28cc3da8a|1790726403|": { nonce: 5886242, hash: "000000569c69a56be904d70482edfabf894fdadc3873a7bf4d5cfae913bf77ae" },
};

function powSearch(prefixAscii: string, target: string): { nonce: number; hash: string } {
  const baked = BAKED[prefixAscii];
  if (baked) return baked;
  const prefix = utf8ToBytes(prefixAscii);
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

type ChainModule = typeof import("./chain");

async function freshChain(): Promise<ChainModule> {
  vi.resetModules();
  const chain = await import("./chain");
  await chain.initChain(new MemoryStorage());
  return chain;
}

async function mineOne(chain: ChainModule): Promise<{ height: number; hash: string }> {
  const tpl = await chain.buildTemplate(w1.address);
  const ts = tpl.minTimestamp;
  const { nonce } = powSearch(
    `WQD1|${tpl.height}|${tpl.prevHash}|${tpl.merkleRoot}|${ts}|`,
    tpl.target,
  );
  const r = await chain.submitBlock(tpl.templateId, ts, nonce);
  return { height: r.height, hash: r.hash };
}

// Bootstrap era: 500 WQD per block; solo miner (zero attesting peers)
// mints only the 70% share = 350; the other 150 (10% burn + unclaimed 20%
// pool) is gone forever.
const BLOCK_EMISSION = 500 * COIN;
const SOLO_MINTED = 350 * COIN;
const SOLO_BURNED = BLOCK_EMISSION - SOLO_MINTED; // 150 WQD

describe("totalBurned - the BURNED FOREVER counter", () => {
  it("genesis: nothing emitted, nothing burned", async () => {
    const chain = await freshChain();
    const info = await chain.getInfo();
    expect(info.totalSupply).toBe(0);
    expect(info.totalBurned).toBe(0);
  });

  it("one solo block: 500 emitted, 350 minted, exactly 150 burned", async () => {
    const chain = await freshChain();
    await mineOne(chain);
    const info = await chain.getInfo();
    expect(info.totalSupply).toBe(SOLO_MINTED);
    expect(info.totalBurned).toBe(SOLO_BURNED);
    // conservation: emission = supply + burned, to the last base unit
    expect(info.totalSupply + info.totalBurned).toBe(BLOCK_EMISSION);
  }, 300_000);

  it("fees join the burn: a mined transfer burns its fee on top of the split", async () => {
    const chain = await freshChain();
    await mineOne(chain); // fund w1 (baked)

    const unsigned = { from: w1.address, to: w2.address, amount: 10 * COIN, fee: 1_000, nonce: 0 };
    const signature = signTransfer(w1.privHex, unsigned);
    await chain.admitTransfer({ ...unsigned, pubkey: w1.pubHex, signature });

    await mineOne(chain); // includes the transfer - live PoW (new merkle)
    const info = await chain.getInfo();
    expect(info.totalSupply).toBe(2 * SOLO_MINTED - 1_000); // fee left existence
    expect(info.totalBurned).toBe(2 * SOLO_BURNED + 1_000); // and joined the counter
    expect(info.totalSupply + info.totalBurned).toBe(2 * BLOCK_EMISSION);
    expect((await chain.getAddressOverview(w2.address)).balance).toBe(10 * COIN);
  }, 300_000);

  it("rollback un-burns exactly what the undone blocks had burned", async () => {
    const chain = await freshChain();
    await mineOne(chain);
    await mineOne(chain);
    expect((await chain.getInfo()).totalBurned).toBe(2 * SOLO_BURNED);

    await chain.rollbackToHeight(1);
    const info = await chain.getInfo();
    expect(info.height).toBe(1);
    expect(info.totalBurned).toBe(SOLO_BURNED); // emission cache rebuilt, not stale
    expect(info.totalSupply + info.totalBurned).toBe(BLOCK_EMISSION);
  }, 300_000);

  it("import: a fresh node derives the full burned figure from the file", async () => {
    const src = await freshChain();
    for (let h = 1; h <= 3; h++) await mineOne(src);
    const file = JSON.parse(JSON.stringify(await src.exportChain())) as unknown;
    expect((await src.getInfo()).totalBurned).toBe(3 * SOLO_BURNED);

    const dst = await freshChain();
    await dst.importChain(file);
    const info = await dst.getInfo();
    expect(info.height).toBe(3);
    expect(info.totalBurned).toBe(3 * SOLO_BURNED);
    expect(info.totalSupply + info.totalBurned).toBe(3 * BLOCK_EMISSION);
  }, 300_000);
});
