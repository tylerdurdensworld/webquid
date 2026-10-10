/**
 * Import safety - the chain can never be downgraded by a file, and the
 * balance math has a numeric proof.
 *
 *   - SHORTER file: rejected by default (ChainDowngradeError), local chain
 *     and balances intact - even { replace: true } alone is not enough.
 *     Only { replace, allowDowngrade } (the UI's dangerous override, which
 *     shows both heights and both tip hashes) applies it - and logs it.
 *   - EQUAL height, same tip: "already up to date" no-op.
 *   - EQUAL height, different tip: fork conflict, default = keep local.
 *   - LONGER valid file: applied directly (the normal case).
 *   - LONGER invalid file: rejected before a single write.
 *   - NUMERIC PROOF: the known 14-block reference chain (heights 0-13, 13
 *     coinbases of 350 WQD to one address) imported on an EMPTY node gives
 *     balance === spendable === 4550 WQD, topbar compact "4.55k".
 */
import { describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { COIN, hashMeetsTarget, splitBlockReward } from "@contracts/protocol";
import { walletFromPrivHex } from "@/lib/webquid";
import { fmtCompact } from "@/lib/format";
import { MemoryStorage } from "./storage";

const w1 = walletFromPrivHex("01".repeat(32))!;
const w2 = walletFromPrivHex("02".repeat(32))!;

const BAKED: Record<string, { nonce: number; hash: string }> = {
  "WQD1|1|207d9fa191adc5c4ee74a14c6c5e90164816388f82b4a044a5c17fb3a9530ef7|94b188f363ae97aa3e38e4ae291beb48b97bd7da0900e74680253d869e07094d|1790726401|": { nonce: 18023509, hash: "0000006cad05f011ff090ee83e98576d6d99c613fd620d90d1c2d7b291b8ab48" },
  "WQD1|1|207d9fa191adc5c4ee74a14c6c5e90164816388f82b4a044a5c17fb3a9530ef7|c65767d2fb627992bde5085b987093788ab9ff40deb1ea9e74f3492d7adb5fb3|1790726401|": { nonce: 4968394, hash: "000003ce4a6cf193451979dc41605fb8b19f2e588833c114916dfa1cfcbe2413" },
  "WQD1|2|0000006cad05f011ff090ee83e98576d6d99c613fd620d90d1c2d7b291b8ab48|614a8e6f2bdca9a6c249010ad93256f7fae6d5a647db7832e99fb7235e8200a8|1790726402|": { nonce: 2838971, hash: "00000258b5b575fe3eeaa587c09ef2a6c39d1200092c0d839599982c8aa5414d" },
  "WQD1|3|00000258b5b575fe3eeaa587c09ef2a6c39d1200092c0d839599982c8aa5414d|998b82684c9cdbbf875774531a8ff85e359de44c01061dbaab0ba1e28cc3da8a|1790726403|": { nonce: 5886242, hash: "000000569c69a56be904d70482edfabf894fdadc3873a7bf4d5cfae913bf77ae" },
  "WQD1|4|000000569c69a56be904d70482edfabf894fdadc3873a7bf4d5cfae913bf77ae|da0085c2c80edc649c4dfe7b6baab05d1aa48a94f8667bfe30edf7744abcb920|1790726404|": { nonce: 9027194, hash: "000003125fffa64d2b5c11af2c8c65ed33caa938a58bb2802c9ce219f687a5e5" },
  "WQD1|5|000003125fffa64d2b5c11af2c8c65ed33caa938a58bb2802c9ce219f687a5e5|429901c20adb603092bf504997c1527d4b326db80fb043c55e00e69cb4cf1588|1790726405|": { nonce: 5628852, hash: "000002d5572dac59e0b42f8d11092ed39f134d0b3ab016cac4eef3949bd4b396" },
  "WQD1|6|000002d5572dac59e0b42f8d11092ed39f134d0b3ab016cac4eef3949bd4b396|b7b13d0e1e184ee791d83d346c88a47cfe785ae1aeccbbc494286aa61fdf2858|1790726406|": { nonce: 527719, hash: "0000031dc109404df5716518a9da901c8e95f6bc832765a58b5407aa8a5a7b49" },
  "WQD1|7|0000031dc109404df5716518a9da901c8e95f6bc832765a58b5407aa8a5a7b49|15a5b153d783291abc9a5ccd70789a261ea7f6bd1ff9e816d8637e6bf0a2181f|1790726407|": { nonce: 55633, hash: "0000009e6e914e1e17438cb627d81e83f1de140a3af14dc123f35e148c4ccd12" },
  "WQD1|8|0000009e6e914e1e17438cb627d81e83f1de140a3af14dc123f35e148c4ccd12|aa8eff39947da3628e5bd7e52fd792948be6400561a70be0403a912b86ba98ef|1790726408|": { nonce: 4644249, hash: "000000967129268629f2113e3a3b54183888bb971e6e32b0ee5fd61dfa57e529" },
  "WQD1|9|000000967129268629f2113e3a3b54183888bb971e6e32b0ee5fd61dfa57e529|3690eb1d34349700e07b43050f80d5827bb45d8abdcdecf5b4420e3fc5b70922|1790726409|": { nonce: 17754391, hash: "0000000d4aeb1aacaa63eb196e4fcec5af7e1713636317fe4077a042e966ccae" },  "WQD1|10|0000000d4aeb1aacaa63eb196e4fcec5af7e1713636317fe4077a042e966ccae|18c146d43f96478fd2a871d1c9a4984cb7fad7e1b5ccea02e3740a417251ec40|1790726410|": { nonce: 39213118, hash: "000000b36f8ec1b5b943298c6aaf97d189fda0bf47683d5ea92387b94f539100" },
  "WQD1|11|000000b36f8ec1b5b943298c6aaf97d189fda0bf47683d5ea92387b94f539100|1859ad76362f58a33daf1256ebf060f07bf925c3c47749f1757fbb1ab0fc0023|1790726411|": { nonce: 29420894, hash: "000000f02ffd5dec95b9c504d8ebd0a5be9bea10ef4a654de46c292b92bd3ae1" },
  "WQD1|12|000000f02ffd5dec95b9c504d8ebd0a5be9bea10ef4a654de46c292b92bd3ae1|2861054c99cae2ebc47e00280af2c5effaf3abd879255b33493c841463e45182|1790726412|": { nonce: 40374273, hash: "000000d2099347c5bfd1180450870488557755b3428ab47e9f1da192a5c1e74f" },

  "WQD1|13|000000d2099347c5bfd1180450870488557755b3428ab47e9f1da192a5c1e74f|e22e762786697bf1659178c39e68a6bbc6338b112dd5754112292b19304061f9|1790726413|": { nonce: 46029477, hash: "000000b7fad07e34a4cc4cca7a1affa27aaa7ec91d15732edcc55ac08955161a" },

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

function asFile(data: unknown): unknown {
  return JSON.parse(JSON.stringify(data));
}

describe("import safety - never downgrade the chain", () => {
  it("NUMERIC PROOF: 13 x 350 WQD coinbases on an empty node -> 4550 / 4550 / compact", async () => {
    const src = await freshChain();
    for (let h = 1; h <= 13; h++) await mineOne(src, w1.address);
    const data = asFile(await src.exportChain());

    const dst = await freshChain(); // EMPTY node (genesis only)
    const res = await dst.importChain(data);
    expect(res).toEqual({ height: 13, applied: true });

    const perBlock = splitBlockReward(1, 0).miner; // 350 WQD - the 70% share
    expect(perBlock).toBe(350 * COIN);
    const expected = 13 * perBlock; // 4,550 WQD - no double counting of anything
    const view = await dst.getAddressOverview(w1.address);
    expect(view.balance).toBe(expected);
    expect(view.available).toBe(expected); // no pending outgoing
    expect(view.balance).toBe(4550 * COIN);
    expect(view.available).toBe(4550 * COIN);
    expect(fmtCompact(view.balance)).toBe("4.55k"); // the topbar figure in "WQD: 4.55k"
    // the whole supply is exactly those 13 coinbases - nothing else exists
    expect((await dst.getInfo()).totalSupply).toBe(expected);
  }, 300_000);

  it("a SHORTER file is rejected by default - local chain and balance intact", async () => {
    const src = await freshChain();
    const b1 = await mineOne(src, w1.address);
    const shortFile = asFile(await src.exportChain()); // height 1

    const local = await freshChain();
    await local.importChain(shortFile);
    await mineOne(local, w1.address);
    const tip = await mineOne(local, w1.address); // local is now height 3
    const balBefore = (await local.getAddressOverview(w1.address)).balance;

    const err = await local.importChain(shortFile).catch((e) => e);
    expect(err).toBeInstanceOf(local.ChainDowngradeError);
    expect(err.kind).toBe("downgrade");
    expect(err.local).toEqual({ height: 3, hash: tip.hash });
    expect(err.incoming).toEqual({ height: 1, hash: b1.hash });
    expect(err.message).toMatch(/SHORTER \(H:1\) than your local chain \(H:3\)/);
    expect(err.message).toMatch(/lose 2 block\(s\)/);

    // untouched: tip, balance, and spendable are exactly what they were
    expect((await local.getInfo()).tipHash).toBe(tip.hash);
    const view = await local.getAddressOverview(w1.address);
    expect(view.balance).toBe(balBefore);
    expect(view.available).toBe(balBefore);
  }, 300_000);

  it("{ replace: true } alone is NOT enough for a downgrade", async () => {
    const src = await freshChain();
    await mineOne(src, w1.address);
    const shortFile = asFile(await src.exportChain());

    const local = await freshChain();
    await local.importChain(shortFile);
    await mineOne(local, w1.address);
    const tip = await local.getTipSummary();

    await expect(local.importChain(shortFile, { replace: true })).rejects.toBeInstanceOf(
      local.ChainDowngradeError,
    );
    expect((await local.getTipSummary()).hash).toBe(tip.hash);
  }, 300_000);

  it("dangerous override: shorter file applies ONLY with replace + allowDowngrade, and is logged", async () => {
    const src = await freshChain();
    const b1 = await mineOne(src, w1.address);
    const shortFile = asFile(await src.exportChain());

    const local = await freshChain();
    await local.importChain(shortFile);
    await mineOne(local, w1.address);
    await mineOne(local, w1.address); // local height 3

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const res = await local.importChain(shortFile, { replace: true, allowDowngrade: true });
    expect(res).toEqual({ height: 1, applied: true });
    expect((await local.getTipSummary()).hash).toBe(b1.hash);
    // the override is on record - both heights, both tip hashes
    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toMatch(/DANGEROUS OVERRIDE/);
    expect(logged).toContain(b1.hash);
    warn.mockRestore();
  }, 300_000);

  it("equal height, same tip -> already up to date, zero change", async () => {
    const src = await freshChain();
    await mineOne(src, w1.address);
    const data = asFile(await src.exportChain());

    const dst = await freshChain();
    await dst.importChain(data);
    const res = await dst.importChain(data);
    expect(res).toEqual({ height: 1, applied: false });
  }, 300_000);

  it("equal height, different tip -> fork warning, default keeps local", async () => {
    const src = await freshChain();
    const fileTip = await mineOne(src, w1.address);
    const data = asFile(await src.exportChain());

    const local = await freshChain();
    const localTip = await mineOne(local, w2.address); // same height, other chain

    const err = await local.importChain(data).catch((e) => e);
    expect(err).toBeInstanceOf(local.ChainConflictError);
    expect(err.kind).toBe("fork");
    expect(err.local.hash).toBe(localTip.hash);
    expect(err.incoming.hash).toBe(fileTip.hash);
    // default = keep local
    expect((await local.getTipSummary()).hash).toBe(localTip.hash);
    // explicit opt-in replaces
    const res = await local.importChain(data, { replace: true });
    expect(res).toEqual({ height: 1, applied: true });
    expect((await local.getTipSummary()).hash).toBe(fileTip.hash);
  }, 300_000);

  it("a LONGER valid file applies directly - the normal case needs no confirmation", async () => {
    const src = await freshChain();
    await mineOne(src, w1.address);
    await mineOne(src, w1.address);
    const fileTip = await mineOne(src, w1.address); // height 3
    const data = asFile(await src.exportChain());

    const local = await freshChain();
    await mineOne(local, w2.address); // a DIFFERENT local chain, height 1

    const res = await local.importChain(data); // no replace flag at all
    expect(res).toEqual({ height: 3, applied: true });
    expect((await local.getTipSummary()).hash).toBe(fileTip.hash);
    // balances recomputed from the resulting chain: w2's local history is gone
    expect((await local.getAddressOverview(w2.address)).balance).toBe(0);
    expect((await local.getAddressOverview(w1.address)).balance).toBe(3 * 350 * COIN);
  }, 300_000);

  it("a LONGER invalid file is rejected - local chain fully intact", async () => {
    const src = await freshChain();
    await mineOne(src, w1.address);
    await mineOne(src, w1.address);
    const data = asFile(await src.exportChain()) as Awaited<ReturnType<typeof src.exportChain>>;
    data.blocks[2].txs[0].amount += 1; // forged coinbase on the longer chain

    const local = await freshChain();
    const localTip = await mineOne(local, w2.address);
    await expect(local.importChain(data)).rejects.toThrow(/coinbase|amount/i);
    expect((await local.getTipSummary()).hash).toBe(localTip.hash);
    expect((await local.getAddressOverview(w2.address)).balance).toBe(350 * COIN);
  }, 300_000);
});
