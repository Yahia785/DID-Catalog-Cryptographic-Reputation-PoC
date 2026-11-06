import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Interface, Transaction, Wallet } from 'ethers';
import { DEV_KEY, JsonRpc, WalletChain, currentFees, deployContract, estimateNeedWei, feeOf, hashJwt, loadArtifact, modeB, runWindowed, startLocalNode, timedRecordedAt, type LocalNode, type Receipt, type TxChain } from '../src/bench/e2-lib.js';

describe('hashJwt', () => {
  it('is the SHA-256 of the string as bytes32 (known example: "abc")', () => {
    assert.equal(hashJwt('abc'), '0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('is 32 bytes and changes with one character', () => {
    assert.match(hashJwt('a.b.c'), /^0x[0-9a-f]{64}$/);
    assert.notEqual(hashJwt('a.b.c'), hashJwt('a.b.d'));
  });
});

describe('fee arithmetic', () => {
  it('gas × price in gwei, ETH and USD', () => {
    const f = feeOf(50_000, 20_000_000_000n, 3000);   // 50k gas at 20 gwei = 1,000,000 gwei = 0.001 ETH
    assert.equal(f.gwei, 1_000_000); assert.ok(Math.abs(f.eth - 0.001) < 1e-12); assert.ok(Math.abs(f.usd! - 3) < 1e-9);
    assert.equal(feeOf(1, 1n, null).usd, null);
  });
  it('the dry-run estimate is (deploy + n × record) × price × 1.5', () => {
    assert.equal(estimateNeedWei(100_000, 50_000, 200, 1_000_000_000n, 50), (100_000n + 200n * 50_000n) * 1_000_000_000n * 3n / 2n);
  });
});

/** A mock chain: send and inclusion take time, and the mock records how many were waiting at once. */
function mockChain(inclusionMs: (i: number) => number) {
  let waiting = 0, maxWaiting = 0, now = 0;
  const sent: number[] = [];
  const chain: TxChain = {
    now: () => performance.now(), backoffMs: () => 0,
    async send(_h, nonce) { sent.push(nonce); await new Promise((r) => setTimeout(r, 1)); waiting++; maxWaiting = Math.max(maxWaiting, waiting); return `0x${nonce.toString(16)}`; },
    async waitForReceipt(txHash): Promise<Receipt> {
      const i = Number(txHash);
      await new Promise((r) => setTimeout(r, inclusionMs(i)));
      waiting--; now++;
      return { txHash, blockNumber: now, gasUsed: 47_000n, effectiveGasPrice: 1n, status: true, contractAddress: null };
    },
  };
  return { chain, sent, max: () => maxWaiting };
}

describe('at most 10 waiting (mock provider)', () => {
  it('Mode B sends all 100 with consecutive nonces and never has more than 10 waiting', async () => {
    const m = mockChain((i) => 150 + (i % 7));
    const hashes = Array.from({ length: 100 }, (_, i) => hashJwt(`h${i}`));
    const r = await modeB(m.chain, hashes, 5, 10);
    assert.equal(r.results.length, 100);
    assert.deepEqual(m.sent, Array.from({ length: 100 }, (_, i) => 5 + i));
    assert.ok(m.max() <= 10, `max waiting ${m.max()}`);
    assert.equal(m.max(), 10, 'the window is actually used');
    assert.equal(r.maxWaiting, m.max());
    assert.ok(r.results.every((x, i) => x.index === i && x.ms > 0));
    assert.ok(r.throughput > 0);
  });
  it('runWindowed holds the next submission back while the window is full', async () => {
    let waiting = 0, max = 0;
    await runWindowed(25, 3, async () => { waiting++; max = Math.max(max, waiting); return { done: new Promise<void>((r) => setTimeout(() => { waiting--; r(); }, 2)) }; });
    assert.equal(max, 3);
  });
  it('a failure stops further submissions and is reported', async () => {
    let sent = 0;
    await assert.rejects(runWindowed(50, 5, async (i) => { sent++; if (i === 7) throw new Error('boom'); return { done: Promise.resolve(i) }; }), /boom/);
    assert.ok(sent < 50);
  });
});

describe('CredentialRegistry on a local chain', { timeout: 120_000 }, () => {
  let node: LocalNode, rpc: JsonRpc, address: string, wallet: Wallet, chainId: bigint;
  const art = loadArtifact(), iface = new Interface(art.abi as any);
  before(async () => {
    node = await startLocalNode(8598);
    rpc = new JsonRpc(node.url);
    wallet = new Wallet(DEV_KEY);
    chainId = BigInt(await rpc.send('eth_chainId'));
    address = (await deployContract(rpc, wallet, chainId, art, await currentFees(rpc), 5)).address;
  });
  after(async () => { await node?.stop(); });

  const record = async (h: string) => {
    const chain = new WalletChain(rpc, wallet, address, chainId, await currentFees(rpc), 5, art.abi);
    const nonce = Number(BigInt(await rpc.send('eth_getTransactionCount', [wallet.address, 'pending'])));
    return chain.waitForReceipt(await chain.send(h, nonce));
  };

  it('returns 0 for an unknown hash', async () => {
    assert.deepEqual((await timedRecordedAt(rpc, address, art.abi, [hashJwt('never recorded')])).timestamps, [0n]);
  });
  it('records a hash, returns its timestamp, and emits Recorded', async () => {
    const h = hashJwt('first');
    const rc = await record(h);
    assert.equal(rc.status, true);
    const raw = await rpc.send('eth_getTransactionReceipt', [rc.txHash]);
    assert.equal(raw.logs.length, 1);
    const ev = iface.parseLog(raw.logs[0])!;
    assert.equal(ev.name, 'Recorded'); assert.equal(ev.args[0], h);
    const ts = (await timedRecordedAt(rpc, address, art.abi, [h])).timestamps[0];
    assert.ok(ts > 0n); assert.equal(ev.args[1], ts);
  });
  it('rejects a duplicate hash', async () => {
    const h = hashJwt('twice');
    await record(h);
    const raw = await new Wallet(DEV_KEY).signTransaction({
      type: 2, chainId, nonce: Number(BigInt(await rpc.send('eth_getTransactionCount', [wallet.address, 'pending']))), to: address, value: 0n,
      data: iface.encodeFunctionData('record', [h]), gasLimit: 120_000n, ...(await currentFees(rpc)),
    });
    // the node refuses the duplicate already when it executes it (gas estimate / mining reverts), so the call fails or the receipt has status 0
    let rejected = false;
    try {
      await rpc.send('eth_sendRawTransaction', [raw]);
      const rc = await rpc.send('eth_getTransactionReceipt', [Transaction.from(raw).hash!]);
      rejected = !rc || BigInt(rc.status) === 0n;
    } catch { rejected = true; }
    assert.ok(rejected, 'the duplicate was accepted');
    assert.equal((await timedRecordedAt(rpc, address, art.abi, [h])).timestamps.length, 1);
  });
});
