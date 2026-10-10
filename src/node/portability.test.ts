/**
 * Chain portability, hardened: the export file is untrusted input.
 * - strict schema: whitelisted fields, wrong types rejected, unknown dropped
 * - zero-trust validation: every hash recomputed, target schedule replayed,
 *   linkage, timestamps, cooldown, coinbase splits, merkle roots, PoP
 *   attestations, signatures, checkpoints, and a full ledger replay - all
 *   BEFORE a single write (all-or-nothing)
 * - conflicts: a differing local chain shows both tips and needs an explicit
 *   { replace: true } - never a silent overwrite
 * - no secrets: the export can never carry wallet key material
 */
import { describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { hashMeetsTarget } from "@contracts/protocol";
import { walletFromPrivHex } from "@/lib/webquid";
import { MemoryStorage } from "./storage";

const w1 = walletFromPrivHex("01".repeat(32))!;
const w2 = walletFromPrivHex("02".repeat(32))!;

const BAKED: Record<string, { nonce: number; hash: string }> = {
  "WQD1|1|207d9fa191adc5c4ee74a14c6c5e90164816388f82b4a044a5c17fb3a9530ef7|94b188f363ae97aa3e38e4ae291beb48b97bd7da0900e74680253d869e07094d|1790726401|": { nonce: 18023509, hash: "0000006cad05f011ff090ee83e98576d6d99c613fd620d90d1c2d7b291b8ab48" },
  "WQD1|1|207d9fa191adc5c4ee74a14c6c5e90164816388f82b4a044a5c17fb3a9530ef7|c65767d2fb627992bde5085b987093788ab9ff40deb1ea9e74f3492d7adb5fb3|1790726401|": { nonce: 4968394, hash: "000003ce4a6cf193451979dc41605fb8b19f2e588833c114916dfa1cfcbe2413" },
  "WQD1|2|0000006cad05f011ff090ee83e98576d6d99c613fd620d90d1c2d7b291b8ab48|614a8e6f2bdca9a6c249010ad93256f7fae6d5a647db7832e99fb7235e8200a8|1790726402|": { nonce: 2838971, hash: "00000258b5b575fe3eeaa587c09ef2a6c39d1200092c0d839599982c8aa5414d" },
  "WQD1|2|0000006cad05f011ff090ee83e98576d6d99c613fd620d90d1c2d7b291b8ab48|f2a951a8c94c4cca1f9774ae9202e627a09f11740e4e0e55abf83c96dab78385|1790726402|": { nonce: 3158745, hash: "0000036a53ccec4814ca4362e09d83813c284ce046f4c3475a70485e88abeeb8" },
  "WQD1|3|00000258b5b575fe3eeaa587c09ef2a6c39d1200092c0d839599982c8aa5414d|998b82684c9cdbbf875774531a8ff85e359de44c01061dbaab0ba1e28cc3da8a|1790726403|": { nonce: 5886242, hash: "000000569c69a56be904d70482edfabf894fdadc3873a7bf4d5cfae913bf77ae" },
  "WQD1|3|0000036a53ccec4814ca4362e09d83813c284ce046f4c3475a70485e88abeeb8|741d79f24fe4c96ac7d9cd0c979fedb54710b588dcba779d58b709dc73bdb435|1790726403|": { nonce: 4336988, hash: "00000221dfec6db25159fc09dac3f00850db8ecb2bdd362f831fad476c014752" },
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

async function mineOne(chain: ChainModule, miner: string): Promise<{ height: number; hash: string }> {
  const tpl = await chain.buildTemplate(miner);
  const ts = tpl.minTimestamp;
  const { nonce } = powSearch(
    `WQD1|${tpl.height}|${tpl.prevHash}|${tpl.merkleRoot}|${ts}|`,
    tpl.target,
  );
  const r = await chain.submitBlock(tpl.templateId, ts, nonce);
  return { height: r.height, hash: r.hash };
}

/** The export as a plain blob - a file is just bytes, never live objects. */
function asFile(data: unknown): unknown {
  return JSON.parse(JSON.stringify(data));
}

describe("chain export / import", () => {
  it("roundtrips a 2-block chain into a fresh node with zero trust", async () => {
    const src = await freshChain();
    const b2 = await mineOne(src, w1.address).then(() => mineOne(src, w1.address));
    const data = await src.exportChain();
    expect(data.format).toBe("webquid-chain-1");
    expect(data.height).toBe(2);
    expect(data.blocks.length).toBe(3); // genesis + 2

    // the genesis pin in contracts/protocol can never drift from the code
    const proto = await import("@contracts/protocol");
    expect(proto.CHECKPOINTS[0]).toBe(data.blocks[0].hash);

    const dst = await freshChain();
    const res = await dst.importChain(asFile(data));
    expect(res.height).toBe(2);
    const di = await dst.getInfo();
    expect(di.tipHash).toBe(b2.hash);
    expect((await dst.getAddressOverview(w1.address)).balance).toBe(
      (await src.getAddressOverview(w1.address)).balance,
    );
    expect(di.totalSupply).toBe((await src.getInfo()).totalSupply);
  }, 240_000);

  it("refuses export files of the retired pre-re-genesis chain", async () => {
    // Regression pin: export files written by the retired network carry the
    // CURRENT format magic but the retired chain id and the retired genesis.
    // Such a file is a foreign chain - it must be refused, never imported.
    // (The literal retired identifiers appear here the same way they appear
    // in the wipe machinery: naming the foreign network so it stays OUT.)
    const src = await freshChain();
    await mineOne(src, w1.address);
    const legacy = asFile(await src.exportChain()) as Record<string, unknown>;
    legacy.chainId = "bitweb-mainnet-1"; // the retired chain id, verbatim
    legacy.blocks = (legacy.blocks as Array<Record<string, unknown>>).map((b, i) =>
      i === 0
        ? { ...b, hash: "c56c7b1e6bd77fb1cce41b3cb76d05a54c3bfd719db2942066daddf3a52352c3" } // retired genesis
        : b,
    );

    const dst = await freshChain();
    await expect(dst.importChain(legacy)).rejects.toThrow(/chain id mismatch/);
    expect((await dst.getInfo()).height).toBe(0); // nothing applied
  }, 240_000);

  it("refuses a foreign network's export", async () => {
    const src = await freshChain();
    const data = await src.exportChain();
    const dst = await freshChain();
    const foreign = { ...(asFile(data) as Record<string, unknown>), chainId: "webquid-mainnet-9" };
    await expect(dst.importChain(foreign)).rejects.toThrow(
      /chain id mismatch/,
    );
  });

  it("conflicting local chain: both tips surface, explicit replace required", async () => {
    const src = await freshChain();
    const fileTip = await mineOne(src, w1.address);
    const data = asFile(await src.exportChain());

    const dst = await freshChain();
    const localTip = await mineOne(dst, w2.address); // a DIFFERENT chain (different miner)

    // no silent overwrite: a typed conflict carries BOTH tips for the UI
    const err = await dst.importChain(data).catch((e) => e);
    expect(err).toBeInstanceOf(dst.ChainConflictError);
    expect(err.local).toEqual({ height: 1, hash: localTip.hash });
    expect(err.incoming).toEqual({ height: 1, hash: fileTip.hash });

    // the local chain is untouched by the refused import
    expect((await dst.getInfo()).tipHash).toBe(localTip.hash);

    // explicit confirmation replaces: rebuilt from the fully validated file
    const res = await dst.importChain(data, { replace: true });
    expect(res.height).toBe(1);
    expect((await dst.getInfo()).tipHash).toBe(fileTip.hash);
    expect((await dst.getAddressOverview(w2.address)).balance).toBe(0); // local history gone
  }, 240_000);

  it("same tip = idempotent no-op, no conflict", async () => {
    const src = await freshChain();
    await mineOne(src, w1.address);
    const data = asFile(await src.exportChain());
    const dst = await freshChain();
    await dst.importChain(data);
    // importing the same file again must not ask for confirmation
    const res = await dst.importChain(data);
    expect(res.height).toBe(1);
  }, 240_000);

  it("refuses gaps, wrong genesis and garbage", async () => {
    const src = await freshChain();
    await mineOne(src, w1.address);
    await mineOne(src, w1.address);
    const data = await src.exportChain();

    const gappy = asFile(data) as typeof data;
    gappy.blocks = [gappy.blocks[0], gappy.blocks[2]]; // height 1 missing
    const dst = await freshChain();
    await expect(dst.importChain(gappy)).rejects.toThrow(/gap/);

    const wrongGenesis = asFile(data) as typeof data;
    wrongGenesis.blocks[0] = { ...wrongGenesis.blocks[0], hash: "ff".repeat(32) };
    await expect(dst.importChain(wrongGenesis)).rejects.toThrow(/genesis/);

    await expect(dst.importChain(null)).rejects.toThrow(/not a chain export file/);
    await expect(dst.importChain({ format: "webquid-chain-9" })).rejects.toThrow(
      /not a chain export file/,
    );
  }, 240_000);
});

describe("import validation - never trust the file", () => {
  it("rejects a tampered miner (miner !== coinbase.toAddress)", async () => {
    const src = await freshChain();
    await mineOne(src, w1.address);
    const data = asFile(await src.exportChain()) as Awaited<ReturnType<typeof src.exportChain>>;
    data.blocks[1].miner = w2.address; // tamper: reroute the block to another miner
    const dst = await freshChain();
    await expect(dst.importChain(data)).rejects.toThrow(/coinbase|miner/i);
    expect((await dst.getInfo()).height).toBe(0); // all-or-nothing: nothing applied
  }, 240_000);

  it("rejects a tampered coinbase amount", async () => {
    const src = await freshChain();
    await mineOne(src, w1.address);
    const data = asFile(await src.exportChain()) as Awaited<ReturnType<typeof src.exportChain>>;
    data.blocks[1].txs[0].amount += 1; // one unit more than the 70% share
    const dst = await freshChain();
    await expect(dst.importChain(data)).rejects.toThrow(/coinbase|amount/i);
    expect((await dst.getInfo()).height).toBe(0);
  }, 240_000);

  it("rejects broken prevHash linkage", async () => {
    const src = await freshChain();
    await mineOne(src, w1.address);
    await mineOne(src, w1.address);
    const data = asFile(await src.exportChain()) as Awaited<ReturnType<typeof src.exportChain>>;
    data.blocks[2].prevHash = "00".repeat(32);
    const dst = await freshChain();
    await expect(dst.importChain(data)).rejects.toThrow();
    expect((await dst.getInfo()).height).toBe(0);
  }, 240_000);

  it("rejects a forged chain with re-mined blocks past a checkpoint", async () => {
    // real chain: three blocks by w1; pin height 2 as a checkpoint (the
    // operator workflow: a new pin every CHECKPOINT_INTERVAL blocks)
    const real = await freshChain();
    await mineOne(real, w1.address);
    const b2 = await mineOne(real, w1.address);
    const b3 = await mineOne(real, w1.address);
    const proto = await import("@contracts/protocol");
    (proto.CHECKPOINTS as Record<number, string>)[2] = b2.hash;

    // forged chain: same height, valid PoW, but re-mined from block 2 on
    // (different miner -> different coinbase -> different hashes)
    const forged = await freshChain();
    const fproto = await import("@contracts/protocol");
    (fproto.CHECKPOINTS as Record<number, string>)[2] = b2.hash; // same pin in this realm
    await mineOne(forged, w1.address);
    await mineOne(forged, w2.address); // diverges here: valid block, wrong history
    await mineOne(forged, w2.address);
    const forgedFile = asFile(await forged.exportChain());

    // the forged file is internally consistent and passes every check EXCEPT
    // the checkpoint pin - and that is exactly what must stop it
    await expect(real.importChain(forgedFile, { replace: true })).rejects.toThrow(/checkpoint/);
    const info = await real.getInfo();
    expect(info.tipHash).toBe(b3.hash); // untouched
    expect(info.height).toBe(3);

    // and no reorg may cross the pin either
    await expect(real.rollbackToHeight(1)).rejects.toThrow(/checkpoint/);
  }, 240_000);

  it("schema: wrong types rejected, unknown fields dropped", async () => {
    const src = await freshChain();
    await mineOne(src, w1.address);
    const data = asFile(await src.exportChain()) as Awaited<ReturnType<typeof src.exportChain>>;

    const wrongType = JSON.parse(JSON.stringify(data));
    wrongType.blocks[1].height = "1"; // string where a number belongs
    const dst = await freshChain();
    await expect(dst.importChain(wrongType)).rejects.toThrow(/bad integer/);

    const extra = JSON.parse(JSON.stringify(data));
    extra.blocks[1].evilScript = "<script>alert(1)</script>"; // unknown field
    extra.adminBackdoor = true;
    const clean = src.sanitizeChainExport(extra);
    expect("evilScript" in clean.blocks[1]).toBe(false);
    expect("adminBackdoor" in clean).toBe(false);
    await expect(dst.importChain(extra)).resolves.toEqual({ height: 1, applied: true }); // clean import after dropping
  }, 240_000);
});

describe("no secrets, no script - the file is inert public data", () => {
  it("export never contains the wallet's private key", async () => {
    const src = await freshChain();
    await mineOne(src, w1.address); // w1 is ON the chain as a miner
    const data = await src.exportChain();
    const json = JSON.stringify(data);
    expect(json.includes(w1.privHex)).toBe(false);
    expect(json.includes(w2.privHex)).toBe(false);
    // structural scan: no secret-shaped field anywhere in the payload
    expect(() => src.assertExportCarriesNoSecrets(data, [w1.privHex])).not.toThrow();
    // negative control: the net must catch key material if it ever appears
    const leaked = JSON.parse(json) as Record<string, unknown>;
    leaked.note = w1.privHex;
    expect(() => src.assertExportCarriesNoSecrets(leaked as never, [w1.privHex])).toThrow(
      /key material/,
    );
    const leakedField = JSON.parse(json) as Record<string, unknown>;
    leakedField.privateKeyBackup = "abc";
    expect(() => src.assertExportCarriesNoSecrets(leakedField as never)).toThrow(/secret-like/);
  }, 240_000);

  it("XSS payload in a block message stays inert text", async () => {
    const src = await freshChain();
    await mineOne(src, w1.address);
    const data = asFile(await src.exportChain()) as Awaited<ReturnType<typeof src.exportChain>>;
    // the message field is committed to by NOTHING (not in the header
    // preimage) - it is free-form data and must be treated as inert text
    const payload = "<img src=x onerror=alert(document.cookie)>";
    data.blocks[1].message = payload;
    const dst = await freshChain();
    const res = await dst.importChain(data);
    expect(res.height).toBe(1);
    const stored = await dst.getWireBlock(1);
    expect(stored?.message).toBe(payload); // stored verbatim, never parsed
    // and no UI layer ever injects chain strings as HTML (source invariant)
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const scan = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? scan(join(dir, e.name)) : e.name.endsWith(".tsx") ? [join(dir, e.name)] : [],
      );
    for (const f of scan(join(__dirname, ".."))) {
      expect(readFileSync(f, "utf8")).not.toMatch(/dangerouslySetInnerHTML/);
    }
  }, 240_000);
});

describe("cooperative validation slicing", () => {
  it("a full-file validation yields macrotask slots and reports live progress", async () => {
    // The validator is pure CPU over the WHOLE chain; run synchronously it
    // pinned the main thread for minutes and Safari killed the page. Force
    // the time-slice to expire on the very first block (2nd Date.now call)
    // and prove: the import still validates + applies bit-for-bit, and the
    // gate carried a live "validating block i/N" detail during the proof.
    const src = await freshChain();
    await mineOne(src, w1.address).then(() => mineOne(src, w1.address));
    const data = asFile(await src.exportChain());

    const dst = await freshChain();
    const gate = await import("./chain-gate");
    const details: Array<string | null> = [];
    gate.subscribeChainGate((st) => details.push(st.detail));

    const realNow = Date.now;
    let call = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => {
      // Every call jumps the clock +1s: the slice-start read and the loop
      // check land 1s apart no matter how many unrelated Date.now calls the
      // import path makes first, so the slice fires on EVERY block. 1s per
      // call stays far below the 6s IDB stall budget (a guard sees ~2 calls
      // per request) and adds only seconds of simulated drift - timestamps
      // are unaffected (the baked chain is days in the past). A retune of
      // VALIDATE_SLICE_MS beyond 1s breaks this test loudly instead of
      // silently disabling the coverage.
      call += 1;
      return realNow() + call * 1_000;
    });
    try {
      const res = await dst.importChain(data);
      expect(res.applied).toBe(true);
      expect(res.height).toBe(2);
    } finally {
      spy.mockRestore();
    }
    expect(details.some((d) => d === "validating block 1/2")).toBe(true);
    const tip = await dst.getTipSummary();
    expect(tip.height).toBe(2);
  }, 240_000);
});
