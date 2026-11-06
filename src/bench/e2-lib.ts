import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Interface, Transaction, Wallet, getCreateAddress } from 'ethers';

/**
 * E2 building blocks: hashing, a JSON-RPC client with rate-limit backoff, the two measured modes (one after another,
 * all at once with at most N waiting), finality polling, the local Hardhat node and the mainnet price lookups.
 * Everything chain-facing sits behind the small TxChain interface so the logic can be tested with a mock.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CHAIN_DIR = path.join(HERE, 'e2-chain');
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── hashing and artifact ─────────────────────────────────────
/** SHA-256 of the JWT string (UTF-8), as the 0x-prefixed bytes32 the contract stores. */
export function hashJwt(jwt: string): string {
  return `0x${crypto.createHash('sha256').update(jwt, 'utf8').digest('hex')}`;
}

export interface Artifact { contract: string; compiler: string; sourceSha256: string; abi: unknown[]; bytecode: string }
export function loadArtifact(): Artifact {
  return JSON.parse(fs.readFileSync(path.join(CHAIN_DIR, 'CredentialRegistry.json'), 'utf8'));
}

// ── JSON-RPC with backoff ────────────────────────────────────
const RETRIABLE = /rate|limit|too many|exceeded|timeout|timed out|temporarily|try again|busy|ECONNRESET|fetch failed|socket|ETIMEDOUT|EAI_AGAIN/i;

/**
 * Plain JSON-RPC over HTTP. Rate-limit and transient errors are retried with exponential backoff; the time spent
 * backing off is added to backoffMs so the benchmark can leave it out of its timings.
 */
export class JsonRpc {
  backoffMs = 0;
  retries = 0;
  requests = 0;
  constructor(readonly url: string, private readonly opts: { maxRetries?: number; baseBackoffMs?: number } = {}) {}

  async send<T = any>(method: string, params: unknown[] = []): Promise<T> {
    const max = this.opts.maxRetries ?? 8, base = this.opts.baseBackoffMs ?? 1000;
    for (let attempt = 0; ; attempt++) {
      let failure: Error;
      this.requests++;
      try {
        const res = await fetch(this.url, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30_000),
        });
        if ([429, 502, 503, 504].includes(res.status)) failure = new Error(`HTTP ${res.status} (rate limit or busy)`);
        else {
          const body = (await res.json().catch(() => null)) as { result?: T; error?: { code: number; message: string } } | null;
          if (!body) failure = new Error(`HTTP ${res.status}: not JSON`);
          else if (body.error) {
            if (body.error.code === -32005 || RETRIABLE.test(body.error.message)) failure = new Error(body.error.message);
            else throw Object.assign(new Error(`${method}: ${body.error.message}`), { rpcCode: body.error.code, fatal: true });
          } else return body.result as T;
        }
      } catch (e) {
        if ((e as { fatal?: boolean }).fatal) throw e;
        failure = e as Error;
        if (!RETRIABLE.test(String(failure.message) + String((failure as { cause?: unknown }).cause ?? ''))) throw failure;
      }
      if (attempt >= max) throw new Error(`${method} failed after ${attempt} retries: ${failure.message}`);
      const wait = Math.min(30_000, base * 2 ** attempt);
      this.retries++;
      this.backoffMs += wait;
      await sleep(wait);
    }
  }
}

// ── the chain behind an interface ────────────────────────────
export interface Receipt { txHash: string; blockNumber: number; gasUsed: bigint; effectiveGasPrice: bigint; status: boolean; contractAddress: string | null }
export interface TxChain {
  /** Sign and submit record(h) with this nonce; resolves with the transaction hash once the node has accepted it. */
  send(h: string, nonce: number): Promise<string>;
  /** Resolves when the transaction is included in a block. */
  waitForReceipt(txHash: string): Promise<Receipt>;
  /** Time spent backing off after rate limits so far (left out of every timing). */
  backoffMs(): number;
  now(): number;
}
export interface TxResult {
  index: number; hash: string; txHash: string; nonce: number; ms: number; sentAt: number; includedAt: number;
  blockNumber: number; gasUsed: number; effectiveGasPrice: bigint; status: boolean;
}

/** Mode A: one after another. Per credential: time from send until included, minus any backoff. */
export async function modeA(chain: TxChain, hashes: string[], startNonce: number, onProgress?: (i: number, r: TxResult) => void): Promise<TxResult[]> {
  const out: TxResult[] = [];
  for (let i = 0; i < hashes.length; i++) {
    const t0 = chain.now(), b0 = chain.backoffMs();
    const txHash = await chain.send(hashes[i], startNonce + i);
    const rc = await chain.waitForReceipt(txHash);
    const t1 = chain.now();
    const r: TxResult = { index: i, hash: hashes[i], txHash, nonce: startNonce + i, ms: t1 - t0 - (chain.backoffMs() - b0), sentAt: t0, includedAt: t1,
      blockNumber: rc.blockNumber, gasUsed: Number(rc.gasUsed), effectiveGasPrice: rc.effectiveGasPrice, status: rc.status };
    if (!rc.status) throw new Error(`record(${hashes[i]}) reverted (tx ${txHash})`);
    out.push(r); onProgress?.(i, r);
  }
  return out;
}

/**
 * Run `n` jobs in index order, never more than `limit` waiting at once. send(i) submits job i and resolves with a
 * `{ done }` holding a promise for its completion (wrapped, because a promise returned from a promise would be flattened); submissions are made one at a time (so nonces reach the node in order), and the next
 * one is held back while `limit` earlier ones are still waiting.
 */
export async function runWindowed<T>(n: number, limit: number, send: (i: number) => Promise<{ done: Promise<T> }>): Promise<T[]> {
  if (limit < 1) throw new Error('limit must be at least 1');
  const results = new Array<T>(n);
  const waiting = new Set<Promise<void>>();
  let failure: unknown;
  for (let i = 0; i < n && failure === undefined; i++) {
    while (waiting.size >= limit) await Promise.race(waiting);
    if (failure !== undefined) break;
    let inclusion: Promise<T>;
    try { inclusion = (await send(i)).done; } catch (e) { failure = e; break; }
    const p: Promise<void> = inclusion.then((v) => { results[i] = v; }, (e) => { failure ??= e; }).finally(() => { waiting.delete(p); });
    waiting.add(p);
  }
  await Promise.all(waiting);
  if (failure !== undefined) throw failure;
  return results;
}

export interface ModeBResult { results: TxResult[]; firstSendAt: number; lastIncludedAt: number; wallMs: number; throughput: number; maxWaiting: number }

/** Mode B: all at once with consecutive nonces, never more than `limit` waiting. Throughput = n / (first send → last inclusion). */
export async function modeB(chain: TxChain, hashes: string[], startNonce: number, limit = 10): Promise<ModeBResult> {
  let waiting = 0, maxWaiting = 0;
  const b0 = chain.backoffMs();
  const results = await runWindowed<TxResult>(hashes.length, limit, async (i) => {
    const t0 = chain.now(), bs = chain.backoffMs();
    const txHash = await chain.send(hashes[i], startNonce + i);
    waiting++; maxWaiting = Math.max(maxWaiting, waiting);
    const done = chain.waitForReceipt(txHash).then((rc) => {
      waiting--;
      const t1 = chain.now();
      if (!rc.status) throw new Error(`record(${hashes[i]}) reverted (tx ${txHash})`);
      return { index: i, hash: hashes[i], txHash, nonce: startNonce + i, ms: t1 - t0 - (chain.backoffMs() - bs), sentAt: t0, includedAt: t1,
        blockNumber: rc.blockNumber, gasUsed: Number(rc.gasUsed), effectiveGasPrice: rc.effectiveGasPrice, status: rc.status };
    }, (e) => { waiting--; throw e; });
    return { done };
  });
  const firstSendAt = Math.min(...results.map((r) => r.sentAt)), lastIncludedAt = Math.max(...results.map((r) => r.includedAt));
  const wallMs = lastIncludedAt - firstSendAt - (chain.backoffMs() - b0);
  return { results, firstSendAt, lastIncludedAt, wallMs, throughput: hashes.length / (wallMs / 1000), maxWaiting };
}

// ── real chain implementation ────────────────────────────────
export interface Fees { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
export const RECORD_GAS_LIMIT = 120_000n;
export const DEPLOY_GAS_LIMIT = 500_000n;

export function parseReceipt(r: any): Receipt {
  return { txHash: r.transactionHash, blockNumber: Number(BigInt(r.blockNumber)), gasUsed: BigInt(r.gasUsed), effectiveGasPrice: BigInt(r.effectiveGasPrice ?? 0), status: BigInt(r.status) === 1n, contractAddress: r.contractAddress ?? null };
}

export class WalletChain implements TxChain {
  private readonly iface: Interface;
  constructor(readonly rpc: JsonRpc, private readonly wallet: Wallet, private readonly contract: string, private readonly chainId: bigint,
    private readonly fees: Fees, private readonly pollMs: number, abi: unknown[], private readonly timeoutMs = 15 * 60_000) {
    this.iface = new Interface(abi as any);
  }
  now() { return performance.now(); }
  backoffMs() { return this.rpc.backoffMs; }
  async send(h: string, nonce: number): Promise<string> {
    const raw = await this.wallet.signTransaction({ type: 2, chainId: this.chainId, nonce, to: this.contract, value: 0n, data: this.iface.encodeFunctionData('record', [h]), gasLimit: RECORD_GAS_LIMIT, ...this.fees });
    await this.rpc.send('eth_sendRawTransaction', [raw]);
    return Transaction.from(raw).hash!;
  }
  waitForReceipt(txHash: string) { return waitForReceipt(this.rpc, txHash, this.pollMs, this.timeoutMs); }
}

export async function waitForReceipt(rpc: JsonRpc, txHash: string, pollMs: number, timeoutMs = 15 * 60_000): Promise<Receipt> {
  const start = performance.now();
  for (;;) {
    const r = await rpc.send('eth_getTransactionReceipt', [txHash]);
    if (r) return parseReceipt(r);
    if (performance.now() - start > timeoutMs) throw new Error(`transaction ${txHash} not included after ${Math.round(timeoutMs / 1000)} s`);
    await sleep(pollMs);
  }
}

/** Current fee settings: maxFee = 3 × base fee + tip (room for the base fee to rise while a transaction waits). */
export async function currentFees(rpc: JsonRpc): Promise<Fees & { baseFeePerGas: bigint }> {
  const block = await rpc.send('eth_getBlockByNumber', ['latest', false]);
  const base = BigInt(block.baseFeePerGas ?? 0);
  let tip: bigint;
  try { tip = BigInt(await rpc.send('eth_maxPriorityFeePerGas')); } catch { tip = 1_000_000_000n; }
  return { baseFeePerGas: base, maxPriorityFeePerGas: tip, maxFeePerGas: 3n * base + tip };
}

export async function deployContract(rpc: JsonRpc, wallet: Wallet, chainId: bigint, art: Artifact, fees: Fees, pollMs: number) {
  const nonce = Number(BigInt(await rpc.send('eth_getTransactionCount', [wallet.address, 'pending'])));
  const raw = await wallet.signTransaction({ type: 2, chainId, nonce, to: null, value: 0n, data: art.bytecode, gasLimit: DEPLOY_GAS_LIMIT, ...fees });
  const t0 = performance.now(), b0 = rpc.backoffMs;
  await rpc.send('eth_sendRawTransaction', [raw]);
  const txHash = Transaction.from(raw).hash!;
  const rc = await waitForReceipt(rpc, txHash, pollMs);
  const ms = performance.now() - t0 - (rpc.backoffMs - b0);
  if (!rc.status || !rc.contractAddress) throw new Error(`deployment failed (tx ${txHash})`);
  if (rc.contractAddress.toLowerCase() !== getCreateAddress({ from: wallet.address, nonce }).toLowerCase()) throw new Error('deployed address differs from the expected one');
  return { address: rc.contractAddress, txHash, ms, gasUsed: Number(rc.gasUsed), blockNumber: rc.blockNumber };
}

// ── finality (Sepolia) ───────────────────────────────────────
/**
 * Poll the "finalized" block tag until it covers every transaction. Per transaction: time from its send until the first
 * poll that saw its block finalized (resolution = pollMs). Backoff is excluded.
 */
export async function waitFinality(rpc: JsonRpc, txs: { blockNumber: number; sentAt: number }[], pollMs = 12_000, timeoutMs = 90 * 60_000,
  onPoll?: (finalized: number, pending: number) => void): Promise<{ ms: number[]; polls: number; finalizedBlock: number }> {
  const done: (number | null)[] = txs.map(() => null);
  const start = performance.now();
  let polls = 0, b0 = rpc.backoffMs, fin = 0;
  for (;;) {
    const block = await rpc.send('eth_getBlockByNumber', ['finalized', false]);
    polls++;
    const t = performance.now();
    fin = Number(BigInt(block.number));
    txs.forEach((x, i) => { if (done[i] === null && x.blockNumber <= fin) done[i] = t - x.sentAt - (rpc.backoffMs - b0); });
    const pending = done.filter((d) => d === null).length;
    onPoll?.(fin, pending);
    if (pending === 0) return { ms: done as number[], polls, finalizedBlock: fin };
    if (t - start > timeoutMs) throw new Error(`finality not reached after ${Math.round(timeoutMs / 60000)} min (finalized block ${fin}, ${pending} transactions pending)`);
    await sleep(pollMs);
  }
}

// ── check: recordedAt ────────────────────────────────────────
export async function timedRecordedAt(rpc: JsonRpc, contract: string, abi: unknown[], hashes: string[], paceMs = 0): Promise<{ ms: number[]; timestamps: bigint[] }> {
  const iface = new Interface(abi as any);
  const ms: number[] = [], timestamps: bigint[] = [];
  for (const h of hashes) {
    if (paceMs) await sleep(paceMs);
    const data = iface.encodeFunctionData('recordedAt', [h]);
    const t0 = performance.now(), b0 = rpc.backoffMs;
    const out = await rpc.send<string>('eth_call', [{ to: contract, data }, 'latest']);
    ms.push(performance.now() - t0 - (rpc.backoffMs - b0));
    timestamps.push(BigInt(iface.decodeFunctionResult('recordedAt', out)[0]));
  }
  return { ms, timestamps };
}

// ── local node (Hardhat network) ─────────────────────────────
/** The first account of the standard Hardhat/Anvil development mnemonic. Public, funded only on local dev chains. */
export const DEV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

export function hardhatVersion(): string {
  return JSON.parse(fs.readFileSync(path.resolve('node_modules/hardhat/package.json'), 'utf8')).version;
}

export interface LocalNode { url: string; tool: string; version: string; clientVersion: string; stop(): Promise<void> }
/** Start `hardhat node` (one block per transaction), wait until it answers, return a handle that stops it. */
export async function startLocalNode(port = 8599): Promise<LocalNode> {
  const bin = createRequire(import.meta.url).resolve('hardhat/internal/cli/bootstrap');
  const child = spawn(process.execPath, [bin, 'node', '--hostname', '127.0.0.1', '--port', String(port), '--config', path.join(CHAIN_DIR, 'hardhat.config.cjs')], {
    cwd: path.resolve('.'), env: { ...process.env, HARDHAT_DISABLE_TELEMETRY_PROMPT: 'true' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  let exited = false;
  child.on('exit', () => { exited = true; });
  const url = `http://127.0.0.1:${port}`;
  const rpc = new JsonRpc(url, { maxRetries: 0 });
  const stop = async () => {
    if (exited) return;
    const done = new Promise<void>((r) => child.once('exit', () => r()));
    child.kill();
    await Promise.race([done, sleep(5000)]);
  };
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (exited) throw new Error(`the local node exited early:\n${log.slice(-1500)}`);
    try { await rpc.send('eth_chainId'); break; } catch { /* not up yet */ }
    if (Date.now() > deadline) { await stop(); throw new Error(`the local node did not start in 90 s:\n${log.slice(-1500)}`); }
    await sleep(150);
  }
  const clientVersion = await rpc.send<string>('web3_clientVersion');
  return { url, tool: 'Hardhat Network (hardhat node)', version: hardhatVersion(), clientVersion, stop };
}

// ── mainnet fee context (read only) ──────────────────────────
export interface FeeContext {
  gas: { rpc: string; baseFeeWei: bigint; tipWei: bigint; gasPriceWei: bigint; at: string } | null;
  price: { usd: number; source: string; at: string } | null;
  errors: string[];
}
const MAINNET_RPCS = ['https://eth.drpc.org', 'https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com', 'https://cloudflare-eth.com'];
const PRICE_APIS: { source: string; url: string; pick: (j: any) => number }[] = [
  { source: 'Coinbase spot price API', url: 'https://api.coinbase.com/v2/prices/ETH-USD/spot', pick: (j) => Number(j.data.amount) },
  { source: 'CoinGecko simple price API', url: 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd', pick: (j) => Number(j.ethereum.usd) },
];

export async function mainnetFeeContext(): Promise<FeeContext> {
  const ctx: FeeContext = { gas: null, price: null, errors: [] };
  for (const url of MAINNET_RPCS) {
    try {
      const rpc = new JsonRpc(url, { maxRetries: 1, baseBackoffMs: 500 });
      const chainId = BigInt(await rpc.send('eth_chainId'));
      if (chainId !== 1n) throw new Error(`chain id ${chainId}, not mainnet`);
      const block = await rpc.send('eth_getBlockByNumber', ['latest', false]);
      const base = BigInt(block.baseFeePerGas), tip = BigInt(await rpc.send('eth_maxPriorityFeePerGas'));
      ctx.gas = { rpc: url, baseFeeWei: base, tipWei: tip, gasPriceWei: base + tip, at: new Date().toISOString() };
      break;
    } catch (e) { ctx.errors.push(`mainnet gas price from ${url}: ${(e as Error).message}`); }
  }
  for (const api of PRICE_APIS) {
    try {
      const res = await fetch(api.url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const usd = api.pick(await res.json());
      if (!Number.isFinite(usd) || usd <= 0) throw new Error('no usable price in the response');
      ctx.price = { usd, source: api.source, at: new Date().toISOString() };
      break;
    } catch (e) { ctx.errors.push(`ETH/USD from ${api.source}: ${(e as Error).message}`); }
  }
  return ctx;
}

// ── fee arithmetic ───────────────────────────────────────────
export function feeOf(gas: number, gasPriceWei: bigint, ethUsd: number | null): { gwei: number; eth: number; usd: number | null } {
  const wei = BigInt(Math.round(gas)) * gasPriceWei;
  const eth = Number(wei) / 1e18;
  return { gwei: Number(wei) / 1e9, eth, usd: ethUsd === null ? null : eth * ethUsd };
}

/** ETH needed (in wei) for one deploy and `records` record calls at a gas price, plus a margin (default +50%). */
export function estimateNeedWei(deployGas: number, recordGas: number, records: number, gasPriceWei: bigint, marginPercent = 50): bigint {
  const gas = BigInt(Math.ceil(deployGas)) + BigInt(records) * BigInt(Math.ceil(recordGas));
  return (gas * gasPriceWei * BigInt(100 + marginPercent) + 99n) / 100n;
}
