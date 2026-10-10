/**
 * Two-tab P2P simulation - the spec's acceptance test for the browser node.
 *
 * Two FULLY independent node instances boot in this one process, each on its
 * own fresh module graph (vi.resetModules) and its own MemoryStorage - the
 * exact analogue of two browser tabs. They discover each other over a real
 * BroadcastChannel mesh, handshake, gossip, sync and mine onto THE SAME
 * chain. A forged transaction earns the sender a strike; honest races don't.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { COIN, hashMeetsTarget, splitBlockReward } from "@contracts/protocol";
import { encodeMessage, type WireTx } from "@contracts/wire";
import { signTransfer, walletFromPrivHex } from "@/lib/webquid";
import { txidOfTransfer } from "./blockchain";
import { MemoryStorage, type ChainStorage } from "./storage";

const w1 = walletFromPrivHex("01".repeat(32))!;
const w2 = walletFromPrivHex("02".repeat(32))!;

// -- helpers -----------------------------------------------------------------
async function until(fn: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 100));
  }
}

const BAKED: Record<string, { nonce: number; hash: string }> = {
  "WQD1|1|207d9fa191adc5c4ee74a14c6c5e90164816388f82b4a044a5c17fb3a9530ef7|94b188f363ae97aa3e38e4ae291beb48b97bd7da0900e74680253d869e07094d|1790726401|": { nonce: 18023509, hash: "0000006cad05f011ff090ee83e98576d6d99c613fd620d90d1c2d7b291b8ab48" },
  "WQD1|1|207d9fa191adc5c4ee74a14c6c5e90164816388f82b4a044a5c17fb3a9530ef7|c65767d2fb627992bde5085b987093788ab9ff40deb1ea9e74f3492d7adb5fb3|1790726401|": { nonce: 4968394, hash: "000003ce4a6cf193451979dc41605fb8b19f2e588833c114916dfa1cfcbe2413" },
  "WQD1|1|207d9fa191adc5c4ee74a14c6c5e90164816388f82b4a044a5c17fb3a9530ef7|e541c67a5938b250492f73a903a9b11769fe9c259e46fc2c56ede1d5d7ada142|1791002185|": { nonce: 851600, hash: "000001810ce02c9785bdd8cb873a704df500a0d51b18a38d8741897f16d9bbc0" },
  "WQD1|1|207d9fa191adc5c4ee74a14c6c5e90164816388f82b4a044a5c17fb3a9530ef7|e541c67a5938b250492f73a903a9b11769fe9c259e46fc2c56ede1d5d7ada142|1791008600|": { nonce: 7128202, hash: "000002d0ad6495dfb787d780d51d083f96939d32e2cb2f9cec6a6904d2ed120e" },
  "WQD1|2|0000006cad05f011ff090ee83e98576d6d99c613fd620d90d1c2d7b291b8ab48|614a8e6f2bdca9a6c249010ad93256f7fae6d5a647db7832e99fb7235e8200a8|1790726402|": { nonce: 2838971, hash: "00000258b5b575fe3eeaa587c09ef2a6c39d1200092c0d839599982c8aa5414d" },
  "WQD1|2|0000006cad05f011ff090ee83e98576d6d99c613fd620d90d1c2d7b291b8ab48|700e478ae3459eaab75447632da7c23741ced592bd4b9c7ea8a75351602e3f5a|1790726402|": { nonce: 448025, hash: "000003f6745b97e065a0483da288c49230ba58b564b1d7620195c63bdc2e84b7" },
  "WQD1|2|0000006cad05f011ff090ee83e98576d6d99c613fd620d90d1c2d7b291b8ab48|eab1f98a4054aebedc6776546537c11852ede92b9fbc016e5f3f212592128e15|1790726402|": { nonce: 4733657, hash: "0000030be001dfed3d612994a9d8140e3bf1c7f9d87809d19e5deab135255406" },
  "WQD1|2|000003ce4a6cf193451979dc41605fb8b19f2e588833c114916dfa1cfcbe2413|f2a951a8c94c4cca1f9774ae9202e627a09f11740e4e0e55abf83c96dab78385|1790726402|": { nonce: 6098956, hash: "00000378b09347337df7070755025b2c4a4ba98def3ed8f6ff2941808f305636" },
  "WQD1|3|00000258b5b575fe3eeaa587c09ef2a6c39d1200092c0d839599982c8aa5414d|998b82684c9cdbbf875774531a8ff85e359de44c01061dbaab0ba1e28cc3da8a|1790726403|": { nonce: 5886242, hash: "000000569c69a56be904d70482edfabf894fdadc3873a7bf4d5cfae913bf77ae" },
  "WQD1|3|00000378b09347337df7070755025b2c4a4ba98def3ed8f6ff2941808f305636|741d79f24fe4c96ac7d9cd0c979fedb54710b588dcba779d58b709dc73bdb435|1790726403|": { nonce: 10248328, hash: "0000039cc2b56595d6bc173829a3517f42a307d48f4f972d79297c0fcd881097" },
  "WQD1|4|000000569c69a56be904d70482edfabf894fdadc3873a7bf4d5cfae913bf77ae|da0085c2c80edc649c4dfe7b6baab05d1aa48a94f8667bfe30edf7744abcb920|1790726404|": { nonce: 9027194, hash: "000003125fffa64d2b5c11af2c8c65ed33caa938a58bb2802c9ce219f687a5e5" },
  "WQD1|4|0000039cc2b56595d6bc173829a3517f42a307d48f4f972d79297c0fcd881097|00fee6f72df60bcbece7c540b0e767bd850b97ba9ad2ae15c9d96808e1526520|1790726404|": { nonce: 4537768, hash: "000002f378bf491a5f56a9e2c5eeeae64233d2e7dddaae474da247ea129cd728" },
  "WQD1|5|000002f378bf491a5f56a9e2c5eeeae64233d2e7dddaae474da247ea129cd728|bc0487c9dea11dcc1b02d10a02d7096b77033809fd97e1159507375ecee0a899|1790726405|": { nonce: 35395, hash: "000002f92646673fdd93b06e62c76e2444601018261c9476f2370b5cbb319601" },
  "WQD1|6|000002f92646673fdd93b06e62c76e2444601018261c9476f2370b5cbb319601|01c47f6784702dfe86ba70e752bcb6f0535e042efbad6525230a33100f94f3a2|1790726406|": { nonce: 422607, hash: "000003024ac3de3ca9b797d0164d4607b09b4846ae045f987bff52b2cd5ce13c" },  "WQD1|1|207d9fa191adc5c4ee74a14c6c5e90164816388f82b4a044a5c17fb3a9530ef7|e541c67a5938b250492f73a903a9b11769fe9c259e46fc2c56ede1d5d7ada142|1791010700|": { nonce: 4546334, hash: "00000042e727e5c03ef1e94b00af551d03411d00f3a467167a95439fc3a611e3" },

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

type Booted = Awaited<ReturnType<(typeof import("./client"))["bootNode"]>>;

async function freshNode(
  tabId: string,
  channel?: string,
  extra?: {
    maxReorgDepth?: number;
    storage?: ChainStorage;
    onChainReplaced?: (tip: { height: number; hash: string }) => void;
  },
): Promise<Booted> {
  vi.resetModules();
  const client = await import("./client");
  const { BroadcastTransport } = await import("./transport");
  return client.bootNode({
    storage: extra?.storage ?? new MemoryStorage(),
    transports: [new BroadcastTransport(tabId, channel)],
    webRtc: false,
    maxReorgDepth: extra?.maxReorgDepth,
    onChainReplaced: extra?.onChainReplaced,
  });
}

async function mineWith(node: Booted, miner: string): Promise<{ height: number; hash: string }> {
  const tpl = await node.template(miner);
  const ts = tpl.minTimestamp;
  const { nonce } = powSearch(
    `WQD1|${tpl.height}|${tpl.prevHash}|${tpl.merkleRoot}|${ts}|`,
    tpl.target,
  );
  return node.submitBlock(tpl.templateId, ts, nonce);
}

/**
 * Blocks carrying real attestations must live in wall-clock time: the 300 s
 * freshness window is measured against the block timestamp. Live PoW every
 * run (no bake possible) - used only for the attestation test.
 */
async function mineWithRealtime(node: Booted, miner: string): Promise<{ height: number; hash: string }> {
  const tpl = await node.template(miner);
  const ts = Math.max(tpl.minTimestamp, Math.floor(Date.now() / 1000));
  const { nonce } = powSearch(
    `WQD1|${tpl.height}|${tpl.prevHash}|${tpl.merkleRoot}|${ts}|`,
    tpl.target,
  );
  return node.submitBlock(tpl.templateId, ts, nonce);
}

// -- the simulation ----------------------------------------------------------
let nodeA: Booted;
let nodeB: Booted;

afterAll(() => {
  nodeA?.stop();
  nodeB?.stop();
});

describe("two tabs, one chain - BroadcastChannel P2P simulation", () => {
  it("two independent tabs discover each other and handshake", async () => {
    nodeA = await freshNode("tab-a");
    await new Promise((r) => setTimeout(r, 150)); // tab A is alone first
    expect(nodeA.engine.peerCount()).toBe(0); // -> "NO PEERS CONNECTED" banner state

    nodeB = await freshNode("tab-b");
    await until(() => nodeA.engine.peerCount() === 1 && nodeB.engine.peerCount() === 1, 15_000);

    const seen = nodeA.peers();
    expect(seen.length).toBe(1);
    expect(seen[0].transport).toBe("broadcast");
    expect(seen[0].agent).toContain("webquid-web-mainnet");

    // identical DNA on both tabs
    const [ia, ib] = await Promise.all([nodeA.info(), nodeB.info()]);
    expect(ia.genesisHash).toBe(ib.genesisHash);
    expect(ia.chainId).toBe("webquid-mainnet-1");
  }, 30_000);

  it("a block mined in tab A lands in tab B by gossip", async () => {
    const b1 = await mineWith(nodeA, w1.address);
    expect(b1.height).toBe(1);
    await until(async () => (await nodeB.info()).tipHash === b1.hash, 15_000);
    const r = await nodeB.address(w1.address);
    // bootstrap reward x10, 70% miner share - no peer announced a payout
    // address, so the whole 20% pool + 10% burned away
    expect(r.balance).toBe(350 * COIN);
  }, 60_000);

  it("a transfer signed in tab A reaches tab B's mempool by gossip", async () => {
    const unsigned = {
      from: w1.address,
      to: w2.address,
      amount: 10 * COIN,
      fee: 1_000,
      nonce: 0,
    };
    const signature = signTransfer(w1.privHex, unsigned);
    const { txid } = await nodeA.sendTx({ ...unsigned, pubkey: w1.pubHex, signature });
    expect(txid).toBe(
      txidOfTransfer({ ...unsigned, pubkey: w1.pubHex, signature }),
    );
    await until(async () => (await nodeB.mempool(10)).length === 1, 15_000);
    expect((await nodeB.mempool(10))[0].txid).toBe(txid);
  }, 30_000);

  it("tab B mines the transfer in; both tabs converge on identical state", async () => {
    const b2 = await mineWith(nodeB, w2.address); // B includes the gossiped tx
    expect(b2.height).toBe(2);
    await until(async () => (await nodeA.info()).tipHash === b2.hash, 15_000);

    const [oa, ob] = await Promise.all([
      nodeA.address(w2.address),
      nodeB.address(w2.address),
    ]);
    expect(oa.balance).toBe(ob.balance);
    // 10 received + block #2's 70% miner share - the 1000-unit fee is BURNED
    expect(oa.balance).toBe(360 * COIN);
    const [ia, ib] = await Promise.all([nodeA.info(), nodeB.info()]);
    expect(ia.totalSupply).toBe(ib.totalSupply);
    expect(ia.mempoolSize).toBe(0);
    expect(ib.mempoolSize).toBe(0);
  }, 120_000);

  it("a forged transaction earns the sender exactly one strike", async () => {
    const forgedTx: WireTx = {
      txid: "ab".repeat(32),
      type: "transfer",
      fromAddress: w1.address,
      toAddress: w2.address,
      amount: 1,
      fee: 1_000,
      nonce: 1,
      pubkey: w1.pubHex,
      signature: "cd".repeat(64), // garbage
      timestamp: 1_900_000_000,
    };
    const tabB = nodeA.peers()[0].id;
    nodeA.transports[0].send(tabB, encodeMessage({ type: "tx", tx: forgedTx }));
    // the RECEIVER (tab B) catches the forgery and strikes the sender (tab A)
    await until(() => nodeB.peers()[0]?.strikes === 1, 10_000);
    // honest node is NOT dropped after one strike - the mesh stays up
    expect(nodeA.engine.peerCount()).toBe(1);
    expect(nodeB.engine.peerCount()).toBe(1);
  }, 30_000);

  it("repeating the SAME forged tx earns no extra strikes - gossip dedup", async () => {
    const tabB = nodeA.peers()[0].id;
    const forgedTx: WireTx = {
      txid: "ab".repeat(32),
      type: "transfer",
      fromAddress: w1.address,
      toAddress: w2.address,
      amount: 1,
      fee: 1_000,
      nonce: 1, // identical content to the previous test => same dedup id
      pubkey: w1.pubHex,
      signature: "cd".repeat(64),
      timestamp: 1_900_000_000,
    };
    // two more copies of the already-seen forgery - dropped before verify
    nodeA.transports[0].send(tabB, encodeMessage({ type: "tx", tx: forgedTx }));
    nodeA.transports[0].send(tabB, encodeMessage({ type: "tx", tx: forgedTx }));
    await new Promise((r) => setTimeout(r, 1_500));
    expect(nodeB.peers()[0]?.strikes).toBe(1); // still exactly one

    // a DIFFERENT forgery (new nonce => new dedup id) is a new offence
    const secondForgery: WireTx = { ...forgedTx, nonce: 2, txid: "ef".repeat(32) };
    nodeA.transports[0].send(tabB, encodeMessage({ type: "tx", tx: secondForgery }));
    await until(() => nodeB.peers()[0]?.strikes === 2, 10_000);
    // two strikes, still below the ban threshold - mesh stays up
    expect(nodeA.engine.peerCount()).toBe(1);
    expect(nodeB.engine.peerCount()).toBe(1);
  }, 30_000);

  it("hellos are exchanged exactly once per link - no handshake ping-pong", async () => {
    // isolated channel so only this pair can see each other
    vi.resetModules();
    const clientC = await import("./client");
    const { BroadcastTransport: BTC } = await import("./transport");
    const tc = new BTC("tab-c", "wqd-test-isolated-hello");
    let hellosFromC = 0;
    const origSend = tc.send.bind(tc);
    tc.send = (id, data) => {
      if (data.includes('"type":"hello"')) hellosFromC++;
      origSend(id, data);
    };
    const c = await clientC.bootNode({
      storage: new MemoryStorage(),
      transports: [tc],
      webRtc: false,
    });
    await new Promise((r) => setTimeout(r, 150));

    vi.resetModules();
    const clientD = await import("./client");
    const { BroadcastTransport: BTD } = await import("./transport");
    const d = await clientD.bootNode({
      storage: new MemoryStorage(),
      transports: [new BTD("tab-d", "wqd-test-isolated-hello")],
      webRtc: false,
    });

    await until(() => c.engine.peerCount() === 1 && d.engine.peerCount() === 1, 15_000);
    await until(() => hellosFromC === 1, 10_000);
    // any ping-pong would pile up hundreds of hellos within these 3 seconds
    await new Promise((r) => setTimeout(r, 3_000));
    expect(hellosFromC).toBe(1);

    c.stop();
    d.stop();
  }, 40_000);

  it("a peer on a SHORTER chain never replaces the local chain - longest wins", async () => {
    // tab-g mines two blocks BEFORE tab-h even exists. When h joins, h must
    // catch UP to g; g must never roll back to h's genesis-only chain.
    vi.resetModules();
    const clientG = await import("./client");
    const { BroadcastTransport: BTG } = await import("./transport");
    const g = await clientG.bootNode({
      storage: new MemoryStorage(),
      transports: [new BTG("tab-g", "wqd-test-longest")],
      webRtc: false,
    });
    const gTip = await mineWith(g, w1.address).then(() => mineWith(g, w1.address));
    expect(gTip.height).toBe(2);

    vi.resetModules();
    const clientH = await import("./client");
    const { BroadcastTransport: BTH } = await import("./transport");
    const h = await clientH.bootNode({
      storage: new MemoryStorage(),
      transports: [new BTH("tab-h", "wqd-test-longest")],
      webRtc: false,
    });

    await until(() => g.engine.peerCount() === 1 && h.engine.peerCount() === 1, 15_000);
    // the shorter node syncs up to the longest valid chain
    await until(async () => (await h.info()).tipHash === gTip.hash, 20_000);
    // ...and the longer node is exactly where it was - never replaced
    expect((await g.info()).tipHash).toBe(gTip.hash);
    expect((await g.info()).height).toBe(2);

    g.stop();
    h.stop();
  }, 60_000);

  it("PoP over the wire: a peer-signed attestation earns the pool share", async () => {
    // isolated pair: tab E mines, tab F proves participation with a signature
    vi.resetModules();
    const clientE = await import("./client");
    const { BroadcastTransport: BTE } = await import("./transport");
    const e = await clientE.bootNode({
      storage: new MemoryStorage(),
      transports: [new BTE("tab-e", "wqd-test-pop")],
      webRtc: false,
    });
    await new Promise((r) => setTimeout(r, 150));

    vi.resetModules();
    const clientF = await import("./client");
    const bwF = await import("@/lib/webquid");
    const { BroadcastTransport: BTF } = await import("./transport");
    const f = await clientF.bootNode({
      storage: new MemoryStorage(),
      transports: [new BTF("tab-f", "wqd-test-pop")],
      webRtc: false,
    });
    await until(() => e.engine.peerCount() === 1 && f.engine.peerCount() === 1, 15_000);

    // F creates its wallet AFTER the handshake - the exact Wallet-page flow:
    // save the key, re-announce -> F signs a PoP attestation FOR E's node id.
    const wF = bwF.walletFromPrivHex("0f".repeat(32))!;
    bwF.saveWallet(wF);
    await f.refreshPayout();
    // wait until E's next template actually pays the attested address
    await until(async () => {
      const tpl = await e.template(w1.address);
      return tpl.popRecipients === 1 && tpl.popPerPeer === splitBlockReward(1, 1).perPeer;
    }, 10_000);

    // wall-clock block: the attestation freshness window is measured against
    // the block timestamp, so a real attested block lives in real time
    const wM = walletFromPrivHex("0e".repeat(32))!; // E's miner - not F's address
    const b1 = await mineWithRealtime(e, wM.address);
    expect(b1.height).toBe(1);
    // F independently re-verifies the attestation INSIDE the gossiped block
    await until(async () => (await f.info()).tipHash === b1.hash, 15_000);

    const split = splitBlockReward(1, 1);
    const [minerView, popView, infoF] = await Promise.all([
      f.address(wM.address),
      f.address(wF.address),
      f.info(),
    ]);
    expect(minerView.balance).toBe(split.miner); // 350 WQD - the 70% share
    expect(popView.balance).toBe(split.perPeer); // 100 WQD - attested, verified
    // the burn (50 WQD here) is never minted; no fees in this block
    expect(infoF.totalSupply).toBe(split.miner + split.perPeer);

    e.stop();
    f.stop();
  }, 180_000);
});

describe("chain update gate - live two-tab sync", () => {
  it("a catching-up tab holds the gate (sync reason) until the peer's tip lands", async () => {
    // A exists first and already HAS blocks when B boots: B's hello compare
    // (peer tip > local tip) triggers the catch-up sync path. A private
    // channel keeps this pair deaf to the other describes' long-lived nodes.
    const a = await freshNode("gate-a", "wqd-test-gate");
    await mineWith(a, w1.address);
    await mineWith(a, w1.address);
    const aTip = (await a.info()).tipHash;

    // B boots under the boot gate now: the catch-up sync can begin (and even
    // finish) while bootNode is still resolving, so subscribing after boot
    // would miss it. Reset B's module graph first, subscribe to B's gate
    // BEFORE booting, then boot - the whole boot->sync handoff is observed.
    vi.resetModules();
    const gate = await import("./chain-gate");
    const states: import("./chain-gate").ChainGateState[] = [];
    const unsub = gate.subscribeChainGate((s) => states.push(s));
    const clientB = await import("./client");
    const { BroadcastTransport: BTGateB } = await import("./transport");
    const b = await clientB.bootNode({
      storage: new MemoryStorage(),
      transports: [new BTGateB("gate-b", "wqd-test-gate")],
      webRtc: false,
    });

    await until(async () => (await b.info()).tipHash === aTip, 20_000);
    unsub();

    // the catch-up ran UNDER the gate. Since B's sync begins inside the boot
    // burst, the burst keeps its first reason ("starting up") - the sync
    // phase is visible through the live per-block detail instead...
    expect(states.some((s) => s.active && s.detail?.startsWith("block #"))).toBe(true);
    // ...and every block arrived inside the burst (never outside it)
    const firstActive = states.findIndex((s) => s.active);
    const lastActive = states.map((s) => s.active).lastIndexOf(true);
    expect(states.slice(firstActive, lastActive + 1).every((s) => s.active)).toBe(true);
    // fully released afterwards - no stuck passive mode
    expect(gate.isChainUpdating()).toBe(false);
    // and the state is whole: both tabs agree on the tip and the balance
    expect((await b.info()).tipHash).toBe(aTip);
    expect((await b.address(w1.address)).balance).toBe((await a.address(w1.address)).balance);

    a.stop();
    b.stop();
  }, 120_000);
});

describe("mempool re-gossip - a tx made while alone still confirms", () => {
  it("a late-joining peer receives the pending transfer without a resend", async () => {
    // SOLO mines a block (funds w1) and signs a transfer with ZERO peers -
    // the exact "sender is not mining / was offline" scenario. Before
    // re-gossip, that tx could only ever confirm if the sender mined it
    // themselves. A private channel keeps this pair deaf to the other
    // describes' long-lived nodes.
    const solo = await freshNode("solo", "wqd-test-regossip");
    await mineWith(solo, w1.address);
    const unsigned = { from: w1.address, to: w2.address, amount: 5 * COIN, fee: 1_000, nonce: 0 };
    const signature = signTransfer(w1.privHex, unsigned);
    const { txid } = await solo.sendTx({ ...unsigned, pubkey: w1.pubHex, signature });
    expect((await solo.mempool(10)).length).toBe(1);

    // the peer joins AFTER the fact - nobody re-sends anything
    const late = await freshNode("late", "wqd-test-regossip");
    await until(() => (solo.peers().length === 1 && late.peers().length === 1), 15_000);

    // on-verification + post-sync mempool handoff delivers the pending tx
    // (the first copy can race the late peer's sync and be retried - that
    // retry path is exactly what this test guards)
    await until(async () => (await late.mempool(10)).some((t) => t.txid === txid), 30_000);

    // and the late peer can mine it in - both nodes converge, mempool drains
    const b = await mineWith(late, w2.address);
    expect(b.height).toBe(2);
    await until(async () => (await solo.info()).tipHash === b.hash, 15_000);
    expect((await solo.mempool(10)).length).toBe(0);
    expect((await late.address(w2.address)).balance).toBe(
      (await solo.address(w2.address)).balance,
    );

    solo.stop();
    late.stop();
  }, 120_000);
});

describe("deep fork beyond the walk-back budget - full resync convergence", () => {
  it("a node stranded on a dead fork adopts the longer chain; supply converges exactly", async () => {
    // A and B mine SEPARATE forks from genesis while isolated (different
    // miners -> their chains differ from block 1 on; the fork point IS
    // genesis). A reaches 4, B reaches 6. Both run with a walk-back budget
    // of 2, so rollback can never reach the fork point - the exact state
    // the pre-fix sync bug left real devices in, and the root cause of
    // per-device supply drift: same-looking heights, different chains.
    // Before the fix, A would strike the honest longer peer and both would
    // stay forked forever.
    const CH = "wqd-test-deepfork";
    const aloneA = await freshNode("df-a0", `${CH}-void-a`, { maxReorgDepth: 2 });
    for (let i = 0; i < 4; i++) await mineWith(aloneA, w1.address);
    const aForkTip = (await aloneA.info()).tipHash;
    const aForkSupply = (await aloneA.info()).totalSupply;
    expect((await aloneA.info()).height).toBe(4);
    const aStorage = aloneA.storage;
    aloneA.stop();

    const aloneB = await freshNode("df-b0", `${CH}-void-b`, { maxReorgDepth: 2 });
    for (let i = 0; i < 6; i++) await mineWith(aloneB, w2.address);
    expect((await aloneB.info()).height).toBe(6);
    const bStorage = aloneB.storage;
    const bForkSupply = (await aloneB.info()).totalSupply;
    aloneB.stop();

    // sanity: the two forks genuinely disagree about the money supply
    expect(aForkSupply).not.toBe(bForkSupply);

    // both rejoin on the SHARED channel, carrying their forks. The
    // replacement alarm is wired THROUGH A's boot options - subscribing
    // after boot is a lost race: the whole catch-up (handshake, walk-back,
    // deep download, adoption) can complete inside one boot-bridge poll, so
    // the hook would fire before any post-boot subscription existed.
    const replaced: Array<{ height: number; hash: string }> = [];
    const b = await freshNode("df-b", CH, { storage: bStorage, maxReorgDepth: 2 });
    const a = await freshNode("df-a", CH, {
      storage: aStorage,
      maxReorgDepth: 2,
      onChainReplaced: (tip) => replaced.push(tip),
    });
    await until(() => a.engine.peerCount() === 1 && b.engine.peerCount() === 1, 15_000);

    // A (shorter fork) must adopt B's chain IN FULL...
    const bInfo = await b.info();
    await until(async () => (await a.info()).tipHash === bInfo.tipHash, 30_000);
    expect((await a.info()).height).toBe(6);
    expect(replaced).toEqual([{ height: 6, hash: bInfo.tipHash }]);

    // ...B never moved...
    expect((await b.info()).tipHash).toBe(bInfo.tipHash);

    // ...and the money supply is now EXACTLY equal on both nodes - the
    // regression this test guards. mined/burned derive from it.
    const [ia, ib] = await Promise.all([a.info(), b.info()]);
    expect(ia.totalSupply).toBe(ib.totalSupply);
    expect(ia.totalBurned).toBe(ib.totalBurned);

    // the dead fork is really gone: w1's fork rewards never existed on the
    // adopted chain, on EITHER node
    expect((await a.address(w1.address)).balance).toBe(0);
    expect((await b.address(w1.address)).balance).toBe(0);
    expect((await a.address(w2.address)).balance).toBe(
      (await b.address(w2.address)).balance,
    );
    // A's old tip hash is not part of the adopted chain anymore
    const adopted = await a.storage.blockAt(4);
    expect(adopted?.hash).not.toBe(aForkTip);

    a.stop();
    b.stop();
  }, 180_000);
});
