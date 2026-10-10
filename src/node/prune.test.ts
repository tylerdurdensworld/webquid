/**
 * Pruning under a hostile lens: the opt-in history prune must delete ONLY
 * confirmed tx rows below the horizon, refuse anything inside the reorg
 * window, keep headers/balances/supply/tip perfectly intact, and the node
 * must keep mining and validating afterwards. A pruned node must also
 * REFUSE a full-chain export loudly (its history has holes).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { GENESIS_TIMESTAMP, TARGET_BLOCK_TIME, hashMeetsTarget } from "@contracts/protocol";
import { walletFromPrivHex } from "@/lib/webquid";
import {
  ChainValidationError,
  buildTemplate,
  exportChain,
  getAddressOverview,
  getInfo,
  getWireBlock,
  initChain,
  pruneConfirmedTxsBelow,
  submitBlock,
} from "./chain";
import { MemoryStorage } from "./storage";

const w1 = walletFromPrivHex("01".repeat(32))!;
const PRUNE_NARRATIVE_BLOCKS = 35;

// Coinbase-only chain to w1: every preimage is deterministic, so nonces are
// baked after the first live grind (see chain.test.ts for the pattern).
const BAKED: Record<string, { nonce: number; hash: string }> = {
  "WQD1|10|000001e17c274a291a83b0e1923ab03fa330b9935f4daef285ec699e165cbf29|18c146d43f96478fd2a871d1c9a4984cb7fad7e1b5ccea02e3740a417251ec40|1790727000|": { nonce: 2442728, hash: "000002241f362e45e52b7492af747751301287dee9fc7c2368ae070d81c4de58" },
  "WQD1|11|000002241f362e45e52b7492af747751301287dee9fc7c2368ae070d81c4de58|1859ad76362f58a33daf1256ebf060f07bf925c3c47749f1757fbb1ab0fc0023|1790727060|": { nonce: 2962139, hash: "0000024181a1ccff8519fbf22e0f8f5ed656d55802fdadf2b777ec9e6d778f6b" },
  "WQD1|12|0000024181a1ccff8519fbf22e0f8f5ed656d55802fdadf2b777ec9e6d778f6b|2861054c99cae2ebc47e00280af2c5effaf3abd879255b33493c841463e45182|1790727120|": { nonce: 4655790, hash: "000001dab97d6e0e20eb0cc03a6dcf2395d243111b1e82d017bf973833e5f8d9" },
  "WQD1|13|000001dab97d6e0e20eb0cc03a6dcf2395d243111b1e82d017bf973833e5f8d9|e22e762786697bf1659178c39e68a6bbc6338b112dd5754112292b19304061f9|1790727180|": { nonce: 7150705, hash: "0000027a75696d84def57235b193146810edd859abb240123341ae0fbe321455" },
  "WQD1|14|0000027a75696d84def57235b193146810edd859abb240123341ae0fbe321455|873e2dd8b643636185dc9467b350cd5bb4d6cfd114252e19bd05ae8380168639|1790727240|": { nonce: 4872151, hash: "000001ef8e841519e8aecac7de7e744838dc4aa2b3486b6ccbe8b48adffb51ea" },
  "WQD1|15|000001ef8e841519e8aecac7de7e744838dc4aa2b3486b6ccbe8b48adffb51ea|8fdb0611e6316ed8f4efa926c2cc4e117b11d28068688cf4f442dad6ec2994bf|1790727300|": { nonce: 3406823, hash: "000000d7f77b95a45d53049c7173b035ce1e21db8644d1e31c0b17a65ab14eda" },
  "WQD1|16|000000d7f77b95a45d53049c7173b035ce1e21db8644d1e31c0b17a65ab14eda|544416326a5de7ad94311a7d878dc20856472e590969ef3a9bb338917f1647fd|1790727360|": { nonce: 8243653, hash: "0000012d30c99290c2f6d0f5c28afdaa163c73bd9f2a5cdfdda1154af91e97fa" },
  "WQD1|17|0000012d30c99290c2f6d0f5c28afdaa163c73bd9f2a5cdfdda1154af91e97fa|2b0170197cba8a6500a51cc8efc33de79ddcde7132b2216dbf43958c15461219|1790727420|": { nonce: 5153502, hash: "000001f87f6b614bc1a9e663b1cd3b99d762b921c75b892f1b2968ad25fca17a" },
  "WQD1|18|000001f87f6b614bc1a9e663b1cd3b99d762b921c75b892f1b2968ad25fca17a|c7aa7cce2c654a18addb11c69879492eeeddc786b44f5e284d07b33380958030|1790727480|": { nonce: 14729707, hash: "000002c025e7436b3243839db8c52a802701538c40bbaed054c41d02a5108dcf" },
  "WQD1|19|000002c025e7436b3243839db8c52a802701538c40bbaed054c41d02a5108dcf|38417129f354c717c8649c368d594544c9accd96098606e41bd9159cd5779a0a|1790727540|": { nonce: 7661318, hash: "00000292883267d59703990535b7f10c9a4804f63ab5cc82f0ffebb0468d9ff6" },
  "WQD1|1|207d9fa191adc5c4ee74a14c6c5e90164816388f82b4a044a5c17fb3a9530ef7|94b188f363ae97aa3e38e4ae291beb48b97bd7da0900e74680253d869e07094d|1790726460|": { nonce: 1706516, hash: "000002e1b542604e50ac740fb79b9c0c24c560ed08b7d0c383b8317738ea780c" },
  "WQD1|20|00000292883267d59703990535b7f10c9a4804f63ab5cc82f0ffebb0468d9ff6|fed7705bac97a25f2732dcfa09d348bb1f4d084b5a4bea693bdfc8afa35b8cb3|1790727600|": { nonce: 1077581, hash: "000000b2031f991d89b49d97dd37dd37f8087b7bedece5083a0560d0658dab07" },
  "WQD1|21|000000b2031f991d89b49d97dd37dd37f8087b7bedece5083a0560d0658dab07|73f1f6807bff8101c97b8da1d0d47c60c7ceb8dbf93a5ca7fc0f701602d73442|1790727660|": { nonce: 827404, hash: "000002b4230855d299ee06fcaf9bfefdf3b7bbbf8ff79fdabc624e8f192a1111" },
  "WQD1|22|000002b4230855d299ee06fcaf9bfefdf3b7bbbf8ff79fdabc624e8f192a1111|ca5d4420fc8b493e88f0384eb3d8b85e6c8a158dbb82de59a4d45cc2091fe6a3|1790727720|": { nonce: 9987852, hash: "00000011231a69e872057f6d3a8d233e6c56033586a390d8e726f1ecbcaffd44" },
  "WQD1|23|00000011231a69e872057f6d3a8d233e6c56033586a390d8e726f1ecbcaffd44|6518f2d2d2452c2b1a0263c2b38d74f8d65fd4909cce70f466092ce3f049d5a8|1790727780|": { nonce: 9621745, hash: "0000029c642028fe2b7a740abb297b13b86a4e039a246c2751b226d624a61ff9" },
  "WQD1|24|0000029c642028fe2b7a740abb297b13b86a4e039a246c2751b226d624a61ff9|72e89e3020bc35172b44802cca4069325e26f832b4057ddf76c5dc4e3c62cec7|1790727840|": { nonce: 922118, hash: "000002752f21607348f87136ca44d581f2d49c73765e90e5fe382190dfb83947" },
  "WQD1|25|000002752f21607348f87136ca44d581f2d49c73765e90e5fe382190dfb83947|066e221ff7872e56aaf43ce2f80da58980f243b28596f15ad123e3f375a88b0a|1790727900|": { nonce: 4526123, hash: "000000759d2bc3d4b1ec486e666ecb1984af4e530ec249a58afa99cc9cbf6614" },
  "WQD1|26|000000759d2bc3d4b1ec486e666ecb1984af4e530ec249a58afa99cc9cbf6614|c5869d5029bacf4b355406bc3ec5bb5796b806d7395b3334e1e845bb09f42ea2|1790727960|": { nonce: 4574678, hash: "000000bb068e0a78895a44fda9d1f72d713ecc90013aa608ede79d83313a9d36" },
  "WQD1|27|000000bb068e0a78895a44fda9d1f72d713ecc90013aa608ede79d83313a9d36|5485090488d4b4c34c33ee270eea8f46dbef91459b11d7ea72a9e3a32e82a509|1790728020|": { nonce: 12781395, hash: "000000fd4286d2757535efc7de5d1fce67bfb2615dd36d050f08fc96a325bb36" },
  "WQD1|28|000000fd4286d2757535efc7de5d1fce67bfb2615dd36d050f08fc96a325bb36|616c2b56960293c1f7f3dedc9a73a0530b132356a16a1f6d66ce1b171a8737df|1790728080|": { nonce: 7596602, hash: "00000272989345386a3ba2b30e665f0e0c22b2cf637cce8d3ade4117ff19102e" },
  "WQD1|29|00000272989345386a3ba2b30e665f0e0c22b2cf637cce8d3ade4117ff19102e|15e5037672d03534f3dbd126863be3abde741d34c0f5f9d52811054b9a6daa25|1790728140|": { nonce: 1748842, hash: "0000019e2055a7e3caf75da9352c248c567a80cbda5a2a0df4cee14c87470bf3" },
  "WQD1|2|000002e1b542604e50ac740fb79b9c0c24c560ed08b7d0c383b8317738ea780c|614a8e6f2bdca9a6c249010ad93256f7fae6d5a647db7832e99fb7235e8200a8|1790726520|": { nonce: 9201390, hash: "0000012f46913d8158bf451e4a6628b369249d4e8e3589d40d55504f3517da91" },
  "WQD1|30|0000019e2055a7e3caf75da9352c248c567a80cbda5a2a0df4cee14c87470bf3|7263636e40a1d83da88d7086519a1fafa93ccc6ffe15497905a664bb91e80ba4|1790728200|": { nonce: 4163946, hash: "0000022bd93815717e6e9e0e95977d7fbf7a6208300acf757eb4ba0b71665238" },
  "WQD1|31|0000022bd93815717e6e9e0e95977d7fbf7a6208300acf757eb4ba0b71665238|a6cdbd47736c21362011d6873d708c3429f4cab1dd51045a28db8de48b256ac0|1790728260|": { nonce: 3643816, hash: "0000005ad66d30f3834b1540be8b4cfef015040d22bc9c7f7c5a4fc6a46759da" },
  "WQD1|32|0000005ad66d30f3834b1540be8b4cfef015040d22bc9c7f7c5a4fc6a46759da|65370b3f67cde68f45422ee5aaaa3501b6494dc5b403c56c44dfa30d2ad65a95|1790728320|": { nonce: 1012108, hash: "000001cccda6b81a166ef02fac6bb091dfa439dc3c40d55bda8163399e7cf7b1" },
  "WQD1|33|000001cccda6b81a166ef02fac6bb091dfa439dc3c40d55bda8163399e7cf7b1|c229972c8469af95f87d7ecb702feef48672afadff07424e055c871605f10740|1790728380|": { nonce: 350142, hash: "000001e71b7cf42471a39284de7cd4775bb37eac7aefe67197007ee3c12be9ff" },
  "WQD1|34|000001e71b7cf42471a39284de7cd4775bb37eac7aefe67197007ee3c12be9ff|5790613ba3220225513b3faf0e074dd29e74585ec26fe1e87a9c8e1ee39acd81|1790728440|": { nonce: 10253904, hash: "00000079a8cff2a850417d1eda81a45607d918c7951d81f05d21309c8288c195" },
  "WQD1|35|00000079a8cff2a850417d1eda81a45607d918c7951d81f05d21309c8288c195|2e41d0ce1a8eacb882339b9f064bf5e528d6e4806d5803897f0161297874d771|1790728500|": { nonce: 723048, hash: "000001f75445008b7b494144befa7bf96aa688fca0ee3fa717d866707ec7be48" },
  "WQD1|3|0000012f46913d8158bf451e4a6628b369249d4e8e3589d40d55504f3517da91|998b82684c9cdbbf875774531a8ff85e359de44c01061dbaab0ba1e28cc3da8a|1790726580|": { nonce: 1361420, hash: "000000474a2f923da382c2981671cdb67fb774186e417dfe32369db1d01da2f3" },
  "WQD1|4|000000474a2f923da382c2981671cdb67fb774186e417dfe32369db1d01da2f3|da0085c2c80edc649c4dfe7b6baab05d1aa48a94f8667bfe30edf7744abcb920|1790726640|": { nonce: 5482648, hash: "000002c1c606e7743b05a6f0c375a3f09ee65441529beba7505aaa86a65260c5" },
  "WQD1|5|000002c1c606e7743b05a6f0c375a3f09ee65441529beba7505aaa86a65260c5|429901c20adb603092bf504997c1527d4b326db80fb043c55e00e69cb4cf1588|1790726700|": { nonce: 8585830, hash: "000000817216cbc970e3161ac41fcae4dc2f0551a337631337a5ddb7dda13fd1" },
  "WQD1|6|000000817216cbc970e3161ac41fcae4dc2f0551a337631337a5ddb7dda13fd1|b7b13d0e1e184ee791d83d346c88a47cfe785ae1aeccbbc494286aa61fdf2858|1790726760|": { nonce: 1309757, hash: "0000029e60f24146821f10dcc72efd66f875ff634153c7dc8f139cd9fa2c8077" },
  "WQD1|7|0000029e60f24146821f10dcc72efd66f875ff634153c7dc8f139cd9fa2c8077|15a5b153d783291abc9a5ccd70789a261ea7f6bd1ff9e816d8637e6bf0a2181f|1790726820|": { nonce: 8799576, hash: "000000b8e4d6d881ed8a99456d37b0536c7ecf58ccfecc3df629c2be603d92a6" },
  "WQD1|8|000000b8e4d6d881ed8a99456d37b0536c7ecf58ccfecc3df629c2be603d92a6|aa8eff39947da3628e5bd7e52fd792948be6400561a70be0403a912b86ba98ef|1790726880|": { nonce: 5747203, hash: "000003749c994730b2c5b8fba5e20e2520bb5c69731c50349ce77d571833a566" },
  "WQD1|9|000003749c994730b2c5b8fba5e20e2520bb5c69731c50349ce77d571833a566|3690eb1d34349700e07b43050f80d5827bb45d8abdcdecf5b4420e3fc5b70922|1790726940|": { nonce: 2468036, hash: "000001e17c274a291a83b0e1923ab03fa330b9935f4daef285ec699e165cbf29" },  "WQD1|36|000001f75445008b7b494144befa7bf96aa688fca0ee3fa717d866707ec7be48|1519a975664ebf3d29515ee6dcd9f9e43468e9ffb00165ee9cb92fc4848c072c|1790728560|": { nonce: 4090047, hash: "000000f2439797001f8d0400750a996e15390eb3cc6a740a7a2efd804043b304" },

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

async function mineOne(): Promise<{ height: number; hash: string }> {
  const tpl = await buildTemplate(w1.address);
  // 60s block spacing: the 8-block retarget sees ideal pace and difficulty
  // stays at 1 forever - minTimestamp spacing would clamp 4x harder every
  // 8 blocks and make the long narrative ungrindable.
  const ts = Math.max(tpl.minTimestamp, GENESIS_TIMESTAMP + tpl.height * TARGET_BLOCK_TIME);
  const { nonce } = powSearch(
    `WQD1|${tpl.height}|${tpl.prevHash}|${tpl.merkleRoot}|${ts}|`,
    tpl.target,
  );
  const r = await submitBlock(tpl.templateId, ts, nonce);
  return { height: r.height, hash: r.hash };
}

let storage: MemoryStorage;
let tipHash35 = "";
let supply35 = 0;
let balance35 = 0;

beforeAll(async () => {
  storage = new MemoryStorage();
  await initChain(storage);
  for (let h = 1; h <= PRUNE_NARRATIVE_BLOCKS; h++) {
    const r = await mineOne();
    if (h === PRUNE_NARRATIVE_BLOCKS) tipHash35 = r.hash;
  }
  const i = await getInfo();
  supply35 = i.totalSupply;
  balance35 = (await getAddressOverview(w1.address)).balance;
}, 900_000);

describe("pruneConfirmedTxsBelow", () => {
  it("refuses a horizon inside the reorg window", async () => {
    // tip 35 - MAX_REORG_DEPTH 32 => deepest legal horizon is 3
    await expect(pruneConfirmedTxsBelow(4)).rejects.toThrow(ChainValidationError);
    await expect(pruneConfirmedTxsBelow(35)).rejects.toThrow(ChainValidationError);
  });

  it("prunes below the legal horizon: txs gone, headers stay, state exact", async () => {
    const removed = await pruneConfirmedTxsBelow(3);
    expect(removed).toBeGreaterThan(0);

    // historical txs are gone - those heights can no longer be SERVED
    expect(await getWireBlock(1)).toBeNull();
    expect(await getWireBlock(2)).toBeNull();
    // ...but their HEADERS remain (the chain of proof is unbroken)
    expect((await storage.blockAt(2))?.height).toBe(2);
    // heights at/above the horizon still serve in full
    expect((await getWireBlock(3))?.height).toBe(3);
    expect((await getWireBlock(PRUNE_NARRATIVE_BLOCKS))?.hash).toBe(tipHash35);

    // tip, supply and balances are untouched by the prune
    const i = await getInfo();
    expect(i.height).toBe(PRUNE_NARRATIVE_BLOCKS);
    expect(i.tipHash).toBe(tipHash35);
    expect(i.totalSupply).toBe(supply35);
    expect((await getAddressOverview(w1.address)).balance).toBe(balance35);
  });

  it("a pruned node cannot export a full chain - it says so loudly", async () => {
    await expect(exportChain()).rejects.toThrow(/pruned/);
  });

  it("the pruned node keeps mining and validating", async () => {
    const r = await mineOne(); // block 36 on pruned storage
    expect(r.height).toBe(PRUNE_NARRATIVE_BLOCKS + 1);
    const i = await getInfo();
    expect(i.height).toBe(PRUNE_NARRATIVE_BLOCKS + 1);
  }, 120_000);
});
