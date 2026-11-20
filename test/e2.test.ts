import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Interface, Transaction, Wallet } from 'ethers';
import { DEV_KEY, JsonRpc, WalletChain, currentFees, deployContract, estimateGas, estimateNeedWei, feeOf, gasLimitFrom, hashJwt, revertMessage, planNonces, chooseRecordGas, waitForCode, sendRaw, loadArtifact, modeB, runWindowed, startLocalNode, timedRecordedAt, type LocalNode, type Receipt, type TxChain } from '../src/bench/e2-lib.js';

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
    address = (await deployContract(rpc, wallet, chainId, art, await currentFees(rpc), 5, Number(BigInt(await rpc.send('eth_getTransactionCount', [wallet.address, 'pending']))))).address;
  });
  after(async () => { await node?.stop(); });

  const record = async (h: string) => {
    const chain = new WalletChain(rpc, wallet, address, chainId, await currentFees(rpc), 5, art.abi, 120_000n);
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

describe('gas limits from estimates', () => {
  it('gasLimitFrom is estimate × 1.25, rounded up', () => {
    assert.equal(gasLimitFrom(100_000n), 125_000n);
    assert.equal(gasLimitFrom(1n), 2n);
    assert.equal(gasLimitFrom(47_001n), 58_752n);      // 58751.25 -> 58752
    assert.equal(gasLimitFrom(0n), 0n);
  });
  it('gasLimitFrom is never below the estimate and handles large values exactly', () => {
    for (const e of [1n, 7n, 21_000n, 999_999n]) assert.ok(gasLimitFrom(e) >= e);
    assert.equal(gasLimitFrom(2n ** 60n), (2n ** 60n * 5n) / 4n);
  });
  it('revertMessage gives gas used and limit, and flags out of gas', () => {
    const m = revertMessage('deployment', '0xabc', 500_000n, 500_000n);
    assert.match(m, /status 0/); assert.match(m, /gas used 500000/); assert.match(m, /gas limit 500000/); assert.match(m, /out of gas/);
    assert.doesNotMatch(revertMessage('record(x)', '0xabc', 30_000n, 60_000n), /out of gas/);
    assert.match(revertMessage('record(x)', '0xabc', 1n), /gas limit unknown/);
  });
  it('estimateGas sends eth_estimateGas, with the state override as third parameter when given', async () => {
    const calls: { method: string; params: unknown[] }[] = [];
    const rpc = { send: async (method: string, params: unknown[]) => { calls.push({ method, params }); return '0xc350'; } } as unknown as JsonRpc;
    assert.equal(await estimateGas(rpc, { from: '0xf', data: '0x00' }), 50_000n);
    assert.deepEqual(calls[0].params, [{ from: '0xf', data: '0x00' }, 'latest']);
    await estimateGas(rpc, { from: '0xf', to: '0xt', data: '0x01' }, { '0xt': { code: '0x60' } });
    assert.deepEqual(calls[1].params, [{ from: '0xf', to: '0xt', data: '0x01' }, 'latest', { '0xt': { code: '0x60' } }]);
  });
});

describe('nonce plan', () => {
  it('deploy n, Mode A n+1..n+100, Mode B n+101..n+200', () => {
    const p = planNonces(7);
    assert.equal(p.deploy, 7); assert.equal(p.modeAStart, 8); assert.equal(p.modeBStart, 108); assert.equal(p.next, 208);
    const all = [p.deploy, ...Array.from({ length: 100 }, (_, i) => p.modeAStart + i), ...Array.from({ length: 100 }, (_, i) => p.modeBStart + i)];
    assert.equal(new Set(all).size, 201);
    assert.deepEqual(all, Array.from({ length: 201 }, (_, i) => 7 + i));
  });
  it('works from nonce 0 and for other workload sizes', () => {
    assert.deepEqual(planNonces(0, 3), { deploy: 0, modeAStart: 1, modeBStart: 4, next: 7 });
  });
});

describe('record() estimate choice', () => {
  it('takes the larger of live and override', () => {
    assert.equal(chooseRecordGas(17_466n, 128_488n).gas, 128_488n);
    assert.equal(chooseRecordGas(130_000n, 128_488n).gas, 130_000n);
  });
  it('warns when live is below 50% of override, not at exactly 50% or above', () => {
    assert.equal(chooseRecordGas(17_466n, 128_488n).warn, true);
    assert.equal(chooseRecordGas(50n, 100n).warn, false);
    assert.equal(chooseRecordGas(49n, 100n).warn, true);
    assert.equal(chooseRecordGas(127_400n, 128_488n).warn, false);
  });
  it('uses live alone, without a warning, when there is no override estimate', () => {
    assert.deepEqual(chooseRecordGas(21_000n, null), { gas: 21_000n, warn: false });
  });
});

describe('waitForCode', () => {
  const rpcOf = (answers: string[]) => { let i = 0; return { send: async () => answers[Math.min(i++, answers.length - 1)] } as unknown as JsonRpc; };
  it('needs 3 equal reads in a row; empty reads and differing reads reset the count', async () => {
    const reads = await waitForCode(rpcOf(['0x', '0xAB', '0x', '0xab', '0xab', '0xab']), '0x1', '0xab', { pollMs: 1 });
    assert.equal(reads, 6);
  });
  it('stops with a clear message when the code never appears', async () => {
    await assert.rejects(waitForCode(rpcOf(['0x']), '0x1', '0xab', { pollMs: 1, timeoutMs: 30 }), /did not match the expected runtime code/);
  });
  it('stops when the code is different from the expected', async () => {
    await assert.rejects(waitForCode(rpcOf(['0xcd']), '0x1', '0xab', { pollMs: 1, timeoutMs: 30 }), /different/);
  });
});

describe('sendRaw', () => {
  const failing = (msg: string) => ({ send: async () => { throw new Error(`eth_sendRawTransaction: ${msg}`); } }) as unknown as JsonRpc;
  it('turns "nonce too low" and "already known" into one clear stop message', async () => {
    await assert.rejects(sendRaw(failing('nonce too low: next nonce 2, tx nonce 1'), '0x', 'record(x)'), /refused the nonce.*never re-read.*without retrying/s);
    await assert.rejects(sendRaw(failing('already known'), '0x', 'record(x)'), /refused the nonce/);
  });
  it('passes other errors through unchanged', async () => {
    await assert.rejects(sendRaw(failing('insufficient funds'), '0x', 'x'), /insufficient funds/);
  });
});
