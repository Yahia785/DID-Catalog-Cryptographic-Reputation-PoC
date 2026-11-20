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
export const AMSTERDAM_DIR = path.join(CHAIN_DIR, 'amsterdam');
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
  /** Gas limit set on every record() transaction (for error messages). */
  readonly gasLimit?: bigint;
  /** Time spent backing off after rate limits so far (left out of every timing). */
  backoffMs(): number;
  now(): number;
}
export interface TxResult {
  index: number; hash: string; txHash: string; nonce: number; ms: number; sentAt: number; includedAt: number;
  blockNumber: number; gasUsed: number; effectiveGasPrice: bigint; status: boolean;
}

/** Message for a transaction with status 0: always says how much gas was used and what the limit was. */
export function revertMessage(what: string, txHash: string, gasUsed: bigint, gasLimit?: bigint): string {
  const hit = gasLimit !== undefined && gasUsed >= gasLimit ? ' (all of the gas limit was used: out of gas)' : '';
  return `${what} failed, status 0 (tx ${txHash}): gas used ${gasUsed}, gas limit ${gasLimit ?? 'unknown'}${hit}`;
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
    if (!rc.status) throw new Error(revertMessage(`record(${hashes[i]})`, txHash, rc.gasUsed, chain.gasLimit));
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
      if (!rc.status) throw new Error(revertMessage(`record(${hashes[i]})`, txHash, rc.gasUsed, chain.gasLimit));
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

/** Gas limit from an estimate: 25% headroom, rounded up. The limit is not what is paid: only gas used is charged. */
export function gasLimitFrom(estimate: bigint): bigint {
  return (estimate * 125n + 99n) / 100n;
}

/** eth_estimateGas for a call or contract creation (to omitted). `stateOverride` is the optional third parameter. */
export async function estimateGas(rpc: JsonRpc, tx: { from: string; to?: string | null; data: string }, stateOverride?: Record<string, unknown>): Promise<bigint> {
  const call: Record<string, string> = { from: tx.from, data: tx.data };
  if (tx.to) call.to = tx.to;
  const params: unknown[] = stateOverride ? [call, 'latest', stateOverride] : [call, 'latest'];
  return BigInt(await rpc.send<string>('eth_estimateGas', params));
}

/**
 * Nonce plan, counted locally: read the 'pending' count once before the deploy, never again. Deploy uses `base`, Mode A starts
 * at base + 1, Mode B at base + 1 + n. (A load-balanced RPC can answer a nonce read from a backend that lags behind.)
 */
export function planNonces(base: number, n = 100): { deploy: number; modeAStart: number; modeBStart: number; next: number } {
  return { deploy: base, modeAStart: base + 1, modeBStart: base + 1 + n, next: base + 1 + 2 * n };
}

/**
 * Pick the gas estimate for record(): the larger of the estimate on the live contract and the state-override estimate (which
 * is null when the node would not give one). A live estimate below half the override estimate is suspicious (a lagging
 * backend that does not see the contract's state): `warn` is then true.
 */
export function chooseRecordGas(live: bigint, override: bigint | null): { gas: bigint; warn: boolean } {
  if (override === null) return { gas: live, warn: false };
  return { gas: live > override ? live : override, warn: live * 2n < override };
}

/** True when a send error means the nonce was already used (or the transaction is already known): never retry with another nonce. */
export const NONCE_ERROR = /nonce too low|already known|known transaction|replacement transaction underpriced/i;

/** eth_sendRawTransaction, turning "nonce too low" / "already known" into one clear message. */
export async function sendRaw(rpc: JsonRpc, raw: string, what: string): Promise<void> {
  try { await rpc.send('eth_sendRawTransaction', [raw]); } catch (e) {
    const msg = (e as Error).message;
    if (NONCE_ERROR.test(msg)) throw new Error(`${what}: the node refused the nonce (${msg}). Nonces are counted locally and never re-read from the node, so this run stops here without retrying. Check the wallet's transactions on the block explorer before running again.`);
    throw e;
  }
}

/**
 * Poll eth_getCode until it is non-empty and equals the expected runtime code for `consecutive` reads in a row (a load-balanced
 * RPC can answer from a backend that has not seen the deployment yet). A read that differs resets the count.
 */
export async function waitForCode(rpc: JsonRpc, address: string, expected: string, opts: { pollMs?: number; consecutive?: number; timeoutMs?: number } = {}): Promise<number> {
  const pollMs = opts.pollMs ?? 2000, need = opts.consecutive ?? 3, timeoutMs = opts.timeoutMs ?? 120_000;
  const want = expected.toLowerCase();
  const start = performance.now();
  let ok = 0, reads = 0, last = '';
  for (;;) {
    const code = String(await rpc.send<string>('eth_getCode', [address, 'latest'])).toLowerCase();
    reads++; last = code;
    ok = code !== '0x' && code === want ? ok + 1 : 0;
    if (ok >= need) return reads;
    if (performance.now() - start > timeoutMs) throw new Error(`the code at ${address} did not match the expected runtime code in ${Math.round(timeoutMs / 1000)} s (${reads} reads; last read: ${last === '0x' ? 'empty' : `${(last.length - 2) / 2} bytes, different`}): the RPC may be lagging; stopping`);
    await sleep(pollMs);
  }
}

/** Upper value per record() used by the Sepolia dry run when the node rejects state overrides. */
export const RECORD_GAS_UPPER = 300_000n;

export function parseReceipt(r: any): Receipt {
  return { txHash: r.transactionHash, blockNumber: Number(BigInt(r.blockNumber)), gasUsed: BigInt(r.gasUsed), effectiveGasPrice: BigInt(r.effectiveGasPrice ?? 0), status: BigInt(r.status) === 1n, contractAddress: r.contractAddress ?? null };
}

export class WalletChain implements TxChain {
  private readonly iface: Interface;
  constructor(readonly rpc: JsonRpc, private readonly wallet: Wallet, private readonly contract: string, private readonly chainId: bigint,
    private readonly fees: Fees, private readonly pollMs: number, abi: unknown[], readonly gasLimit: bigint, private readonly timeoutMs = 15 * 60_000) {
    this.iface = new Interface(abi as any);
  }
  now() { return performance.now(); }
  backoffMs() { return this.rpc.backoffMs; }
  async send(h: string, nonce: number): Promise<string> {
    const raw = await this.wallet.signTransaction({ type: 2, chainId: this.chainId, nonce, to: this.contract, value: 0n, data: this.iface.encodeFunctionData('record', [h]), gasLimit: this.gasLimit, ...this.fees });
    await sendRaw(this.rpc, raw, `record(${h})`);
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

/** Deploy with the given nonce (the caller counts nonces). The gas is estimated first (before the clock starts) and the limit is gasLimitFrom(estimate). */
export async function deployContract(rpc: JsonRpc, wallet: Wallet, chainId: bigint, art: Artifact, fees: Fees, pollMs: number, nonce: number) {
  const gasEstimate = await estimateGas(rpc, { from: wallet.address, data: art.bytecode });
  const gasLimit = gasLimitFrom(gasEstimate);
  const raw = await wallet.signTransaction({ type: 2, chainId, nonce, to: null, value: 0n, data: art.bytecode, gasLimit, ...fees });
  const t0 = performance.now(), b0 = rpc.backoffMs;
  await sendRaw(rpc, raw, 'deployment');
  const txHash = Transaction.from(raw).hash!;
  const rc = await waitForReceipt(rpc, txHash, pollMs);
  const ms = performance.now() - t0 - (rpc.backoffMs - b0);
  if (!rc.status || !rc.contractAddress) throw new Error(revertMessage('deployment', txHash, rc.gasUsed, gasLimit));
  if (rc.contractAddress.toLowerCase() !== getCreateAddress({ from: wallet.address, nonce }).toLowerCase()) throw new Error('deployed address differs from the expected one');
  return { address: rc.contractAddress, txHash, ms, gasUsed: Number(rc.gasUsed), blockNumber: rc.blockNumber, gasEstimate, gasLimit };
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

/** Amsterdam EIPs that Hardhat's documentation (hardhat.org/docs/reference/amsterdam-support) lists as supported. The page names no version. */
export const AMSTERDAM_EIPS: string[] = [
  'EIP-2780: Resource-based intrinsic transaction gas', 'EIP-7708: ETH transfers emit logs', 'EIP-7778: Block Gas Accounting without Refunds',
  'EIP-7843: SLOTNUM opcode', 'EIP-7928: Block-Level Access Lists', 'EIP-7954: Increase Maximum Contract Size', 'EIP-7976: Increase Calldata Floor Cost',
  'EIP-7981: Increase Access List Cost', 'EIP-7997: Deterministic Factory Contract', 'EIP-8024: Backward Compatible SWAPN, DUPN, EXCHANGE',
  'EIP-8037: State Creation Gas Cost Increase', 'EIP-8038: State-Access Gas Cost Update', 'EIP-8246: Remove SELFDESTRUCT Burn',
];

export interface LocalNode {
  url: string; tool: string; version: string; clientVersion: string; stop(): Promise<void>;
  /** Hardfork / gas rules the node follows; for Hardhat 3 also the EDR (simulation engine) version and the EIPs Hardhat lists as supported. */
  hardfork: string; edrVersion: string | null; supportedEips: string[] | null;
}
export type LocalKind = 'hardhat2' | 'hardhat3-amsterdam';

/** Start `hardhat node` (one block per transaction), wait until it answers, return a handle that stops it. */
export async function startLocalNode(port = 8599, kind: LocalKind = 'hardhat2'): Promise<LocalNode> {
  const amsterdam = kind === 'hardhat3-amsterdam';
  const hhDir = path.join(AMSTERDAM_DIR, 'node_modules', 'hardhat');
  const bin = amsterdam ? path.join(hhDir, 'dist', 'src', 'cli.js') : createRequire(import.meta.url).resolve('hardhat/internal/cli/bootstrap');
  if (!fs.existsSync(bin)) throw new Error(amsterdam ? `Hardhat 3 is not installed: run  npm install  in ${path.relative('.', AMSTERDAM_DIR)}` : `hardhat not found at ${bin}`);
  const args = amsterdam
    ? ['node', '--hostname', '127.0.0.1', '--port', String(port), '--config', path.join(AMSTERDAM_DIR, 'hardhat.config.js'), '--network', 'default']
    : ['node', '--hostname', '127.0.0.1', '--port', String(port), '--config', path.join(CHAIN_DIR, 'hardhat.config.cjs')];
  const child = spawn(process.execPath, [bin, ...args], {
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
  if (!amsterdam) return { url, tool: 'Hardhat Network (hardhat node)', version: hardhatVersion(), clientVersion, stop, hardfork: 'Hardhat 2 default (older rules than Sepolia now)', edrVersion: null, supportedEips: null };
  const edr = JSON.parse(fs.readFileSync(path.join(AMSTERDAM_DIR, 'node_modules', '@nomicfoundation', 'edr', 'package.json'), 'utf8')).version as string;
  return { url, tool: 'Hardhat 3 simulated L1 (hardhat node)', version: JSON.parse(fs.readFileSync(path.join(hhDir, 'package.json'), 'utf8')).version, clientVersion, stop, hardfork: 'amsterdam', edrVersion: edr, supportedEips: AMSTERDAM_EIPS };
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
