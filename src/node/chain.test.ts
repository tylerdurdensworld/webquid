/**
 * Chain state machine integration - memory adapter, REAL proof-of-work.
 * Genesis seal -> local mining -> transfer confirmation -> reorg rollback ->
 * a competing branch applied from "the wire" -> the chain heals forward.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import {
  GENESIS_TIMESTAMP,
  COIN,
  hashMeetsTarget,
  nowSeconds,
  serializeCoinbase,
  serializePopTransfer,
  splitBlockReward,
  type PopAttestation,
} from "@contracts/protocol";
import type { WireBlock } from "@contracts/wire";
import { signPopAttestation, signTransfer, walletFromPrivHex, type WalletKeys } from "@/lib/webquid";
import { dsha256Hex, merkleRootHex } from "./blockchain";
import {
  ChainValidationError,
  admitTransfer,
  applyWireBlock,
  buildTemplate,
  getAddressOverview,
  getInfo,
  getRecentBlocks,
  getMempool,
  getTipSummary,
  initChain,
  rollbackToHeight,
  setPopAttestationsProvider,
  setPopMinerNodeIdProvider,
  submitBlock,
  violatesMinerCooldown,
  type TemplateView,
} from "./chain";
import { MemoryStorage } from "./storage";

// -- PoW: baked solutions + live search fallback ----------------------------
// The narrative below is fully deterministic (fixed keys, fixed timestamps),
// so every block's winning nonce is constant. They were found once with the
// live search and are baked here - test runs verify them with ONE hash each
// instead of grinding ~2^22 hashes per block. Any narrative change simply
// falls back to the live search (slow but correct) and prints new solutions.
const BAKED: Record<string, { nonce: number; hash: string }> = {
  "WQD1|1|207d9fa191adc5c4ee74a14c6c5e90164816388f82b4a044a5c17fb3a9530ef7|15a9abcc97aecf0eca2bc3ea49a79c3f6745de5dfc8a19fdf297f2eae6f83a70|1790726401|": { nonce: 6744254, hash: "000002887ba0bab427d5618bf005273aac5ab395f6524c28f5172d499f183ce5" },
  "WQD1|1|207d9fa191adc5c4ee74a14c6c5e90164816388f82b4a044a5c17fb3a9530ef7|54230453c53be63a5f4c5af20b51029d2340128580aa64a02d28d05b8b863efa|1790726401|": { nonce: 14184291, hash: "000000863c831fc130f9e65164fe6b0162bdc8f68b86b92403bab8f7ae37e5cf" },
  "WQD1|1|207d9fa191adc5c4ee74a14c6c5e90164816388f82b4a044a5c17fb3a9530ef7|94b188f363ae97aa3e38e4ae291beb48b97bd7da0900e74680253d869e07094d|1790726401|": { nonce: 18023509, hash: "0000006cad05f011ff090ee83e98576d6d99c613fd620d90d1c2d7b291b8ab48" },
  "WQD1|1|207d9fa191adc5c4ee74a14c6c5e90164816388f82b4a044a5c17fb3a9530ef7|c7dc20467cb2c33c2cc8c49ad0ffb6dea842f1d3767929cf5214bb48891bc737|1790726401|": { nonce: 135524, hash: "00000131118f18ed9e5f14480dd146fe46e9662b8cb3adf17a0c1578d2fbec8c" },
  "WQD1|1|207d9fa191adc5c4ee74a14c6c5e90164816388f82b4a044a5c17fb3a9530ef7|cc8ee6431684563edd87acf278ce3833d0741a43ae6be553097d59098b838e14|1790726401|": { nonce: 7166513, hash: "0000018cba5e6e5f7980d4155b993558e9970a26b8719244787410ed94a4f96a" },
  "WQD1|1|207d9fa191adc5c4ee74a14c6c5e90164816388f82b4a044a5c17fb3a9530ef7|f8b268370ea8dfd988e876e4fee2edb8eb00ee1a34b1378f27c425bbe6478963|1790726401|": { nonce: 33643, hash: "000002101f591363da7eb24d9591ac6df2e3418f9267312b9cfae60f55ade5ee" },
  "WQD1|1|207d9fa191adc5c4ee74a14c6c5e90164816388f82b4a044a5c17fb3a9530ef7|f8b268370ea8dfd988e876e4fee2edb8eb00ee1a34b1378f27c425bbe6478963|1791002742|": { nonce: 213361, hash: "0000036762ebc3b77fb459e2cf4be201170627439f31660f8dbf5322aa80f9c1" },
  "WQD1|2|0000006cad05f011ff090ee83e98576d6d99c613fd620d90d1c2d7b291b8ab48|614a8e6f2bdca9a6c249010ad93256f7fae6d5a647db7832e99fb7235e8200a8|1790726402|": { nonce: 2838971, hash: "00000258b5b575fe3eeaa587c09ef2a6c39d1200092c0d839599982c8aa5414d" },
  "WQD1|3|00000258b5b575fe3eeaa587c09ef2a6c39d1200092c0d839599982c8aa5414d|45b2fe176c9f78edee163b16fa15877841bb6e06b2e81930209b25e829c6e19a|1790726403|": { nonce: 1554288, hash: "0000024941bdb0e1fd82dff8acd4e9b2ae0e734f03948dfc4a630337623ac407" },
  "WQD1|3|00000258b5b575fe3eeaa587c09ef2a6c39d1200092c0d839599982c8aa5414d|96ad7492089dadb9c7dee0866a26bb17d3df465d2bf56e89ea1036d0319412f4|1790726403|": { nonce: 17699007, hash: "00000045c54efc29166fa8f5d19f1b3688b73929caefeacbd1029fad4fc78fcf" },
  "WQD1|4|0000024941bdb0e1fd82dff8acd4e9b2ae0e734f03948dfc4a630337623ac407|2e4ca48e6827621566e7d1f606ee488a2318611c976c199c1a04b5ee5c000ff7|1790726404|": { nonce: 1379095, hash: "000002b65805617c5289cbe9757a4e4cf27f8c3ee7b716de4bdd184f6a666298" },
  "WQD1|5|000002b65805617c5289cbe9757a4e4cf27f8c3ee7b716de4bdd184f6a666298|6bb5ea891a1dccc068b05ebe7a786abc9f6b9b9569c4fc6c204484411efd436c|1790726405|": { nonce: 10124137, hash: "00000367f8e17ee3072a5dcd264b2ffa00ee9cccda2b0568d45b1833c1447967" },
  "WQD1|6|00000367f8e17ee3072a5dcd264b2ffa00ee9cccda2b0568d45b1833c1447967|161a06f59e8502e8b11323fc6a1f1b31ff84e0150a8245bca4f63ee287da78eb|1790726406|": { nonce: 1801766, hash: "000002fb24ecb389286ecc615bade88d5697d9e722ee3908e69b6f2c25d2e576" },
  "WQD1|7|000002fb24ecb389286ecc615bade88d5697d9e722ee3908e69b6f2c25d2e576|3225026073491beeb6bd67671c73dd0999260fdfb4da09eaf9b33d48de807c4a|1790726407|": { nonce: 6521724, hash: "00000046d0e6521c19d97ab72929d7228f172c996c0a188a782f6fb0def7070b" },
  "WQD1|7|000002fb24ecb389286ecc615bade88d5697d9e722ee3908e69b6f2c25d2e576|41ac02bbccc9e049f5bb8100f10f88e6e2e5d0408397e08f0ea71e96e29db93d|1790726407|": { nonce: 197648, hash: "000003355e32525e0a9236fca29048e5bed7a25f880eca6b8fe035094a0b4f63" },
  "WQD1|7|000002fb24ecb389286ecc615bade88d5697d9e722ee3908e69b6f2c25d2e576|9d7483dabc3baee4abef734a2f7b37a9616cc417982e5d4c201c80965d142c11|1790726407|": { nonce: 2425093, hash: "000002870163f3ff862aa6a8b48d46f962b220ff85a6b679e2a8ab0d2e30d702" },
  "WQD1|7|000002fb24ecb389286ecc615bade88d5697d9e722ee3908e69b6f2c25d2e576|c47363f619d5bb8cf0641ece8ac712735a936be5847e6025d5e833655587f9c6|1790726407|": { nonce: 313378, hash: "000002ba54090f30d51252ab331d0241bb2b96daf644960b789d1910bffe1b94" },
  "WQD1|7|000002fb24ecb389286ecc615bade88d5697d9e722ee3908e69b6f2c25d2e576|c47363f619d5bb8cf0641ece8ac712735a936be5847e6025d5e833655587f9c6|1791009462|": { nonce: 4083346, hash: "0000020b15f63f8d7367a14abc895e4e690295fdfccb2ccc5417c06746c89444" },  "WQD1|7|000002fb24ecb389286ecc615bade88d5697d9e722ee3908e69b6f2c25d2e576|c47363f619d5bb8cf0641ece8ac712735a936be5847e6025d5e833655587f9c6|1791010652|": { nonce: 1514517, hash: "000002abde357c7ed3d495ef0210da21f1ce5a06fc6c5cd4a3eeda6c2212b9e8" },

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
  throw new Error("nonce space exhausted");
}

async function mineNextBlock(miner: string): Promise<{ height: number; hash: string }> {
  const tpl: TemplateView = await buildTemplate(miner);
  const ts = tpl.minTimestamp; // deterministic - the whole narrative is
  const { nonce } = powSearch(
    `WQD1|${tpl.height}|${tpl.prevHash}|${tpl.merkleRoot}|${ts}|`,
    tpl.target,
  );
  return submitBlock(tpl.templateId, ts, nonce);
}

/**
 * Attestation-acceptance blocks MUST carry a wall-clock timestamp: the 300 s
 * freshness window is measured against the block's timestamp, so a block
 * carrying real attestations has to live in real time too. Non-deterministic
 * (live PoW every run) - only ever used for the LAST block of a narrative.
 */
async function mineNextBlockRealtime(miner: string): Promise<{ height: number; hash: string }> {
  const tpl: TemplateView = await buildTemplate(miner);
  const ts = Math.max(tpl.minTimestamp, nowSeconds());
  const { nonce } = powSearch(
    `WQD1|${tpl.height}|${tpl.prevHash}|${tpl.merkleRoot}|${ts}|`,
    tpl.target,
  );
  return submitBlock(tpl.templateId, ts, nonce);
}

/** A REAL peer-signed attestation - the exact bytes a wallet would produce. */
function attest(w: WalletKeys, minerPeerId: string, timestamp: number): PopAttestation {
  return {
    address: w.address,
    pubkey: w.pubHex,
    signature: signPopAttestation(w.privHex, { minerPeerId, address: w.address, timestamp }),
    timestamp,
  };
}
const TEST_NODE_ID = "wqd-test-miner-node";

/** Craft a valid coinbase-only block extending `storage`'s block at height-1. */
async function craftSideBlock(
  storage: MemoryStorage,
  height: number,
  miner: string,
): Promise<WireBlock> {
  const prev = await storage.blockAt(height - 1);
  if (!prev) throw new Error("side-block parent missing");
  const amount = splitBlockReward(height, 0).miner;
  const cbTxid = dsha256Hex(serializeCoinbase({ height, to: miner, amount }));
  const merkleRoot = merkleRootHex([cbTxid]);
  const ts = prev.timestamp + 1;
  const { nonce, hash } = powSearch(
    `WQD1|${height}|${prev.hash}|${merkleRoot}|${ts}|`,
    prev.target,
  );
  return {
    height,
    hash,
    prevHash: prev.hash,
    merkleRoot,
    timestamp: ts,
    nonce,
    target: prev.target,
    miner,
    message: null,
    txs: [
      {
        txid: cbTxid,
        type: "coinbase",
        fromAddress: null,
        toAddress: miner,
        amount,
        fee: 0,
        nonce: null,
        pubkey: null,
        signature: null,
        timestamp: ts,
      },
    ],
  };
}

// -- the narrative -----------------------------------------------------------
// Every block in this file is a bootstrap-era block with an empty PoP pool
// (unless a test announces peers): miner gets exactly the 70% share.
const MINER_SHARE = splitBlockReward(1, 0).miner;
const storage = new MemoryStorage();
let w1: WalletKeys; // mines the first blocks, sends the transfer
let w2: WalletKeys; // recipient
let w3: WalletKeys; // mines the competing branch

describe("browser chain node - full lifecycle", () => {
  beforeAll(async () => {
    await initChain(storage);
    // fixed keys -> a byte-deterministic narrative (baked PoW stays valid)
    w1 = walletFromPrivHex("01".repeat(32))!;
    w2 = walletFromPrivHex("02".repeat(32))!;
    w3 = walletFromPrivHex("03".repeat(32))!;
  }, 10_000);

  it("seals the deterministic genesis (hash pinned across every node)", async () => {
    const g = await storage.blockAt(0);
    expect(g?.hash).toBe(
      "207d9fa191adc5c4ee74a14c6c5e90164816388f82b4a044a5c17fb3a9530ef7",
    );
    expect(g?.timestamp).toBe(GENESIS_TIMESTAMP);
    const info = await getInfo();
    expect(info.height).toBe(0);
    expect(info.chainId).toBe("webquid-mainnet-1");
    expect(info.totalSupply).toBe(0);
  });

  it("mines two real blocks locally - subsidy lands", async () => {
    const b1 = await mineNextBlock(w1.address);
    expect(b1.height).toBe(1);
    const b2 = await mineNextBlock(w1.address);
    expect(b2.height).toBe(2);
    const acct = await getAddressOverview(w1.address);
    expect(acct.balance).toBe(2 * MINER_SHARE);
    expect(acct.blocksMined).toBe(2);
  }, 120_000);

  it("rejects garbage transfers before they touch the mempool", async () => {
    const unsigned = {
      from: w1.address,
      to: w2.address,
      amount: 10 * COIN,
      fee: 1_000,
      nonce: 0,
    };
    const goodSig = signTransfer(w1.privHex, unsigned);
    await expect(
      admitTransfer({ ...unsigned, pubkey: w1.pubHex, signature: goodSig, nonce: 7 }),
    ).rejects.toThrow(ChainValidationError);
    const forged = signTransfer(w3.privHex, unsigned); // wrong key for w1's address
    await expect(
      admitTransfer({ ...unsigned, pubkey: w1.pubHex, signature: forged }),
    ).rejects.toThrow(ChainValidationError);
  });

  it("confirms a signed transfer in the next block", async () => {
    const unsigned = {
      from: w1.address,
      to: w2.address,
      amount: 10 * COIN,
      fee: 1_000,
      nonce: 0,
    };
    const signature = signTransfer(w1.privHex, unsigned);
    const { txid } = await admitTransfer({ ...unsigned, pubkey: w1.pubHex, signature });
    expect(txid).toMatch(/^[0-9a-f]{64}$/);
    // re-admitting the same tx trips the state guard first (same as the
    // server reference: nonce rule precedes the duplicate check)
    await expect(
      admitTransfer({ ...unsigned, pubkey: w1.pubHex, signature }),
    ).rejects.toThrow(/bad nonce/);
    expect((await getMempool(10)).length).toBe(1);

    const b3 = await mineNextBlock(w1.address);
    expect(b3.height).toBe(3);
    expect((await getMempool(10)).length).toBe(0);
    const r = await getAddressOverview(w2.address);
    expect(r.balance).toBe(10 * COIN);
    const s = await getAddressOverview(w1.address);
    expect(s.nonce).toBe(1);
    // w1 mined block #3 itself, but the 1000-unit fee is BURNED in full -
    // it never comes back to anyone: 3 miner shares - 10 WQD sent - fee.
    expect(s.balance).toBe(3 * MINER_SHARE - 10 * COIN - 1_000);
  }, 120_000);

  it("rolls back one block exactly - mempool, balances, supply restored", async () => {
    await rollbackToHeight(2);
    const tip = await getTipSummary();
    expect(tip.height).toBe(2);
    expect((await getMempool(10)).length).toBe(1); // transfer is pending again
    const r = await getAddressOverview(w2.address);
    expect(r.balance).toBe(0);
    const s = await getAddressOverview(w1.address);
    expect(s.balance).toBe(2 * MINER_SHARE);
    expect(s.nonce).toBe(0);
    const info = await getInfo();
    expect(info.totalSupply).toBe(2 * MINER_SHARE);
  });

  it("applies a competing branch from the wire and keeps the pending tx", async () => {
    const side3 = await craftSideBlock(storage, 3, w3.address);
    await applyWireBlock(side3);
    const side4 = await craftSideBlock(storage, 4, w3.address);
    await applyWireBlock(side4);
    const tip = await getTipSummary();
    expect(tip.height).toBe(4);
    expect(tip.hash).toBe(side4.hash);

    const s = await getAddressOverview(w1.address);
    expect(s.balance).toBe(2 * MINER_SHARE); // block #3 reward stayed rolled back
    const m = await getAddressOverview(w3.address);
    expect(m.balance).toBe(2 * MINER_SHARE); // side branch paid w3
    expect((await getMempool(10)).length).toBe(1); // still pending
  }, 120_000);

  it("mines on the winning branch and confirms the long-pending transfer", async () => {
    const b5 = await mineNextBlock(w3.address);
    expect(b5.height).toBe(5);
    expect((await getMempool(10)).length).toBe(0);
    const r = await getAddressOverview(w2.address);
    expect(r.balance).toBe(10 * COIN);
    const s = await getAddressOverview(w1.address);
    expect(s.nonce).toBe(1);
    const info = await getInfo();
    expect(info.height).toBe(5);
  }, 120_000);

  it("rejects forged wire blocks with ChainValidationError", async () => {
    const tip = await getTipSummary();
    const fake = await craftSideBlock(storage, tip.height + 1, w3.address);
    fake.hash = "0".repeat(64); // lie about the header hash
    await expect(applyWireBlock(fake)).rejects.toThrow(ChainValidationError);
  }, 120_000);

  it("no attestations -> the whole 20% peer pool burns", async () => {
    setPopMinerNodeIdProvider(() => TEST_NODE_ID);
    setPopAttestationsProvider(() => []);
    const before = await getInfo();
    let mined: { height: number; hash: string };
    try {
      mined = await mineNextBlock(w3.address);
    } finally {
      setPopMinerNodeIdProvider(() => null);
    }
    expect(mined.height).toBe(6);
    const after = await getInfo();
    // only the miner's 70% was minted - the unattested pool never existed
    expect(after.totalSupply - before.totalSupply).toBe(splitBlockReward(6, 0).miner);
  }, 120_000);

  it("rejects blocks whose PoP attestations fail in any way", async () => {
    const tip = await getTipSummary();
    const height = tip.height + 1; // 7
    const ts = (await storage.blockAt(height - 1))!.timestamp + 1; // deterministic
    const good1 = splitBlockReward(height, 1);
    const good2 = splitBlockReward(height, 2);

    // (a) INVALID SIGNATURE - garbage bytes where a signature should be
    const badSig = await craftSideBlockFull(
      storage, height, w3.address,
      [{ address: w1.address, amount: good1.perPeer, index: 0 }],
      [{ ...attest(w1, TEST_NODE_ID, ts), signature: "cd".repeat(64) }],
    );
    await expect(applyWireBlock(badSig)).rejects.toThrow(/PoP/);

    // (b) WRONG ADDRESS - the attestation pays w2, the block pays w1
    const wrongAddr = await craftSideBlockFull(
      storage, height, w3.address,
      [{ address: w1.address, amount: good1.perPeer, index: 0 }],
      [attest(w2, TEST_NODE_ID, ts)],
    );
    await expect(applyWireBlock(wrongAddr)).rejects.toThrow(/PoP/);

    // (c) EXPIRED - signed 301 s before the block's timestamp
    const expired = await craftSideBlockFull(
      storage, height, w3.address,
      [{ address: w1.address, amount: good1.perPeer, index: 0 }],
      [attest(w1, TEST_NODE_ID, ts - 301)],
    );
    await expect(applyWireBlock(expired)).rejects.toThrow(/PoP/);

    // (d) UNATTESTED PEER - the miner pays w1 AND w2, but only w1 attested
    const unattested = await craftSideBlockFull(
      storage, height, w3.address,
      [
        { address: w1.address, amount: good2.perPeer, index: 0 },
        { address: w2.address, amount: good2.perPeer, index: 1 },
      ],
      [attest(w1, TEST_NODE_ID, ts)],
    );
    await expect(applyWireBlock(unattested)).rejects.toThrow(/PoP/);

    // (e) NOT THE EQUAL SPLIT - greedy share, attestation itself valid
    const greedy = await craftSideBlockFull(
      storage, height, w3.address,
      [{ address: w1.address, amount: good1.perPeer + 1, index: 0 }],
      [attest(w1, TEST_NODE_ID, ts)],
    );
    await expect(applyWireBlock(greedy)).rejects.toThrow(/PoP/);

    // (f) SELF-PAYMENT - the miner "attests" itself with its own key
    const selfPay = await craftSideBlockFull(
      storage, height, w3.address,
      [{ address: w3.address, amount: good1.perPeer, index: 0 }],
      [attest(w3, TEST_NODE_ID, ts)],
    );
    await expect(applyWireBlock(selfPay)).rejects.toThrow(/PoP/);
  }, 300_000);

  it("valid attestations -> block accepted, pool split equally, burn never mints", async () => {
    const before = await getInfo();
    const [a1, a2, a3] = await Promise.all([
      getAddressOverview(w1.address),
      getAddressOverview(w2.address),
      getAddressOverview(w3.address),
    ]);
    // real signatures, real time - the last block of the narrative (its hash
    // is wall-clock-dependent, so nothing deterministic follows it)
    setPopMinerNodeIdProvider(() => TEST_NODE_ID);
    setPopAttestationsProvider(() => [
      attest(w1, TEST_NODE_ID, nowSeconds()),
      attest(w2, TEST_NODE_ID, nowSeconds()),
      attest(w1, TEST_NODE_ID, nowSeconds()), // duplicate - freshest wins
    ]);
    let mined: { height: number; hash: string };
    try {
      mined = await mineNextBlockRealtime(w3.address);
    } finally {
      setPopAttestationsProvider(() => []);
      setPopMinerNodeIdProvider(() => null);
    }
    expect(mined.height).toBe(7);

    const split = splitBlockReward(7, 2);
    const [b1, b2, b3] = await Promise.all([
      getAddressOverview(w1.address),
      getAddressOverview(w2.address),
      getAddressOverview(w3.address),
    ]);
    expect(b3.balance - a3.balance).toBe(split.miner);
    expect(b1.balance - a1.balance).toBe(split.perPeer);
    expect(b2.balance - a2.balance).toBe(split.perPeer);
    const after = await getInfo();
    expect(after.totalSupply - before.totalSupply).toBe(split.miner + 2 * split.perPeer);

    // the stored block carries the full attestation evidence for sync peers
    const stored = await storage.blockAt(7);
    expect(stored?.minerPeerId).toBe(TEST_NODE_ID);
    expect(stored?.popAttestations.length).toBe(2);
  }, 300_000);
});

/** Like craftSideBlock, but commits to explicit PoP payouts + attestations. */
async function craftSideBlockFull(
  storage: MemoryStorage,
  height: number,
  miner: string,
  pops: Array<{ address: string; amount: number; index: number }>,
  atts: PopAttestation[],
): Promise<WireBlock> {
  const prev = await storage.blockAt(height - 1);
  if (!prev) throw new Error("side-block parent missing");
  const amount = splitBlockReward(height, pops.length).miner;
  const cbTxid = dsha256Hex(serializeCoinbase({ height, to: miner, amount }));
  const popIds = pops.map((pop) =>
    dsha256Hex(
      serializePopTransfer({ height, index: pop.index, to: pop.address, amount: pop.amount }),
    ),
  );
  const merkleRoot = merkleRootHex([cbTxid, ...popIds]);
  const ts = prev.timestamp + 1;
  const { nonce, hash } = powSearch(
    `WQD1|${height}|${prev.hash}|${merkleRoot}|${ts}|`,
    prev.target,
  );
  return {
    height,
    hash,
    prevHash: prev.hash,
    merkleRoot,
    timestamp: ts,
    nonce,
    target: prev.target,
    miner,
    message: null,
    popTransfers: pops,
    minerPeerId: TEST_NODE_ID,
    popAttestations: atts,
    txs: [
      {
        txid: cbTxid,
        type: "coinbase",
        fromAddress: null,
        toAddress: miner,
        amount,
        fee: 0,
        nonce: null,
        pubkey: null,
        signature: null,
        timestamp: ts,
      },
    ],
  };
}

describe("miner cooldown (consensus from block 2,000)", () => {
  it("no address may mine two consecutive blocks once active", () => {
    const a = "wqd1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const b = "wqd1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    expect(violatesMinerCooldown(1, a, a)).toBe(false); // bootstrap era
    expect(violatesMinerCooldown(1_999, a, a)).toBe(false); // below activation
    expect(violatesMinerCooldown(2_000, a, b)).toBe(false); // rotation is fine
    expect(violatesMinerCooldown(2_000, a, null)).toBe(false); // unknown parent
    expect(violatesMinerCooldown(2_000, a, a)).toBe(true); // consecutive self
    expect(violatesMinerCooldown(9_999, a, a)).toBe(true); // stays enforced
  });

  it("below activation a repeat miner still gets a template (the gate opens only at 2,000)", async () => {
    const tip = await getTipSummary();
    expect(tip.height).toBeLessThan(2_000);
    const tipBlock = (await getRecentBlocks(1))[0];
    const tpl = await buildTemplate(tipBlock.miner); // same miner again - allowed here
    expect(tpl.height).toBe(tip.height + 1);
    // ...but that exact pairing becomes a violation the moment the gate opens:
    expect(violatesMinerCooldown(2_000, tipBlock.miner, tipBlock.miner)).toBe(true);
  });
});
