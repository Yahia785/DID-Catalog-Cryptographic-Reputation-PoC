import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Interface, Wallet, formatEther } from 'ethers';
import {
  DEV_KEY, JsonRpc, RECORD_GAS_UPPER, WalletChain, currentFees, deployContract, estimateGas, estimateNeedWei, feeOf, gasLimitFrom, hashJwt, chooseRecordGas, planNonces, waitForCode,
  loadArtifact, mainnetFeeContext, modeA, modeB, startLocalNode, timedRecordedAt, waitFinality, type LocalNode,
} from './e2-lib.js';
import { summarize, type Summary } from './stats.js';

/**
 * Benchmark E2: the same workload as DIDcal, on a blockchain. Record the SHA-256 fingerprint of each of the 100 signed
 * credentials in a minimal contract (CredentialRegistry) and measure what that costs. No fee is paid on mainnet.
 *
 *   npx tsx src/bench/e2.ts --chain=local                       local single-node development chain (Hardhat 2 network, older gas rules), started and stopped here
 *   npx tsx src/bench/e2.ts --chain=local-amsterdam             the same on Hardhat 3 with the amsterdam hardfork (Sepolia's current gas rules)
 *   npx tsx src/bench/e2.ts --chain=sepolia --new-wallet        create output/e2/wallet.json (git-ignored), print only the address
 *   npx tsx src/bench/e2.ts --chain=sepolia --dry-run           balance and estimated need; sends nothing
 *   npx tsx src/bench/e2.ts --chain=sepolia --yes               the real Sepolia run (needed for any real Sepolia run)
 *
 * Measured per chain: deploy; Mode A (one after another, each waits for its receipt); Mode B (all at once, consecutive
 * nonces, at most 10 waiting); finality (Sepolia, after Mode A); the check (recordedAt eth_call). Mode B records a
 * second set of fingerprints, SHA-256("modeB\n" + JWT), because the contract rejects a hash that is already recorded.
 * Rate-limit backoff is never part of a timing. Timings are single user, one laptop.
 * Results: output/bench/e2-<chain>-<ISO>.json and .md.
 */

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const flag = (n: string) => process.argv.includes(`--${n}`);
const CHAIN = arg('chain');
const CREDS = path.resolve(arg('creds') ?? 'output/scores/f1');
const WALLET_FILE = path.resolve('output/e2/wallet.json');
const SEPOLIA_ID = 11155111n;
const DEFAULT_SEPOLIA_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
const WINDOW = 10;                                    // Mode B: never more than this many waiting
const LABEL = 'Single user, one laptop.';
const SEPOLIA_PACE_MS = 150;                          // gap between consecutive requests in the check
const DUMMY_ADDRESS = '0x1111111111111111111111111111111111111111';   // dry run: where the runtime code is placed by a state override
const GAS_ESTIMATE_HASH = hashJwt('gas-estimate');    // fingerprint used only to estimate record(); not in the workload
type ChainName = 'local' | 'local-amsterdam' | 'sepolia';
const SEPOLIA_RULES = 'Glamsterdam (Amsterdam execution layer), active on Sepolia since 2026-10-06; includes EIP-8037 (higher gas for new state: deployed code, new storage slots) and EIP-8038 (state-access gas)';
const GAS_NOTE = 'Gas figures from chains that follow different gas rules (hardforks) are not directly comparable: the same contract and the same calls cost different amounts of gas.';

const log = (s = '') => console.log(s);
const die = (s: string): never => { console.error(s); process.exit(1); };
const ms1 = (x: number) => x.toFixed(1);

// ── Sepolia wallet ───────────────────────────────────────────
function newWallet() {
  fs.mkdirSync(path.dirname(WALLET_FILE), { recursive: true });
  const w = Wallet.createRandom();
  try {
    fs.writeFileSync(WALLET_FILE, JSON.stringify({ address: w.address, privateKey: w.privateKey, createdAt: new Date().toISOString(), note: 'Sepolia test wallet. Never fund it with real money.' }, null, 1), { flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') die(`${path.relative('.', WALLET_FILE)} already exists: not overwritten (delete it yourself to start over)`);
    throw e;
  }
  log(w.address);
}
function loadWallet(): Wallet {
  if (!fs.existsSync(WALLET_FILE)) return die(`${path.relative('.', WALLET_FILE)} not found: run  npx tsx src/bench/e2.ts --chain=sepolia --new-wallet`);
  return new Wallet(JSON.parse(fs.readFileSync(WALLET_FILE, 'utf8')).privateKey);
}

// ── workload ─────────────────────────────────────────────────
function loadCredentials() {
  const files = fs.readdirSync(CREDS).filter((f) => f.endsWith('.vc.jwt')).sort();
  if (files.length !== 100) die(`expected 100 credentials in ${path.relative('.', CREDS)}, found ${files.length}`);
  const jwts = files.map((f) => fs.readFileSync(path.join(CREDS, f), 'utf8').trim());
  const hashesA = jwts.map(hashJwt), hashesB = jwts.map((j) => hashJwt(`modeB\n${j}`));
  if (new Set([...hashesA, ...hashesB]).size !== 200) die('duplicate fingerprints in the workload');
  return { files, jwts, hashesA, hashesB, totalBytes: jwts.reduce((a, j) => a + Buffer.byteLength(j), 0) };
}

const origin = (u: string) => { try { return new URL(u).origin; } catch { return 'unknown'; } };
const gwei = (wei: bigint) => (Number(wei) / 1e9).toString();

// ── Sepolia setup shared by dry run and real run ─────────────
interface RecordEstimate { gas: bigint; basis: string; overridden: boolean }

/** Runtime code of the contract: an eth_call without `to` runs the creation code and returns what would be stored. */
async function runtimeCode(rpc: JsonRpc, from: string, initCode: string): Promise<string> {
  return rpc.send<string>('eth_call', [{ from, data: initCode }, 'latest']);
}

/** Estimate record() before the contract exists: place the runtime code at a dummy address with a state override. If the node refuses, use an upper value. */
async function estimateRecordWithOverride(rpc: JsonRpc, from: string, art: ReturnType<typeof loadArtifact>): Promise<RecordEstimate> {
  const data = new Interface(art.abi as any).encodeFunctionData('record', [GAS_ESTIMATE_HASH]);
  try {
    const code = await runtimeCode(rpc, from, art.bytecode);
    if (!code || code === '0x') throw new Error('no runtime code returned');
    const gas = await estimateGas(rpc, { from, to: DUMMY_ADDRESS, data }, { [DUMMY_ADDRESS]: { code } });
    return { gas, basis: `eth_estimateGas with a state override (runtime code at ${DUMMY_ADDRESS})`, overridden: true };
  } catch (e) {
    return { gas: RECORD_GAS_UPPER, basis: `fixed upper value ${RECORD_GAS_UPPER}: the node did not accept a state-override estimate (${(e as Error).message.slice(0, 160)})`, overridden: false };
  }
}

async function sepoliaContext() {
  try { process.loadEnvFile('.env'); } catch { /* no .env */ }
  const url = process.env.SEPOLIA_RPC_URL || DEFAULT_SEPOLIA_RPC;
  const rpc = new JsonRpc(url);
  const chainId = BigInt(await rpc.send('eth_chainId'));
  if (chainId !== SEPOLIA_ID) die(`the RPC at ${origin(url)} reports chain id ${chainId}, not Sepolia (${SEPOLIA_ID}): stopping`);
  const wallet = loadWallet();
  const art = loadArtifact();
  const balance = BigInt(await rpc.send('eth_getBalance', [wallet.address, 'latest']));
  const fees = await currentFees(rpc);
  const deployEstimate = await estimateGas(rpc, { from: wallet.address, data: art.bytecode });
  const recordEstimate = await estimateRecordWithOverride(rpc, wallet.address, art);
  const price = fees.baseFeePerGas + fees.maxPriorityFeePerGas;
  const deployLimit = gasLimitFrom(deployEstimate), recordLimit = gasLimitFrom(recordEstimate.gas);
  // the need is computed from the gas limits (an upper value of what can be charged), not from the bare estimates
  const need = estimateNeedWei(Number(deployLimit), Number(recordLimit), 200, price, 50);
  return { url, rpc, chainId, wallet, balance, fees, price, need, deployEstimate, deployLimit, recordEstimate, recordLimit, usingDefaultRpc: !process.env.SEPOLIA_RPC_URL };
}

async function dryRun() {
  const c = await sepoliaContext();
  log(`Sepolia dry run (nothing is sent)`);
  log(`  RPC: ${origin(c.url)}${c.usingDefaultRpc ? ' (public default; set SEPOLIA_RPC_URL in .env to use another)' : ' (SEPOLIA_RPC_URL)'}`);
  log(`  wallet ${c.wallet.address}: balance ${formatEther(c.balance)} ETH`);
  log(`  gas price now: base fee ${gwei(c.fees.baseFeePerGas)} gwei + tip ${gwei(c.fees.maxPriorityFeePerGas)} gwei = ${gwei(c.price)} gwei`);
  log(`  deploy: eth_estimateGas ${c.deployEstimate} -> gas limit ${c.deployLimit} (estimate × 1.25)`);
  log(`  record: ${c.recordEstimate.gas} -> gas limit ${c.recordLimit} (× 1.25); basis: ${c.recordEstimate.basis}`);
  log(`  estimate = (deploy limit + 200 × record limit) × gas price × 1.5`);
  log(`           = (${c.deployLimit} + 200 × ${c.recordLimit}) × ${gwei(c.price)} gwei × 1.5 = ${formatEther(c.need)} ETH`);
  const reserve = BigInt(WINDOW) * c.recordLimit * c.fees.maxFeePerGas;
  log(`  the node also reserves gas limit × max fee for each waiting transaction: ${WINDOW} × ${c.recordLimit} × ${gwei(c.fees.maxFeePerGas)} gwei = ${formatEther(reserve)} ETH at the peak of Mode B`);
  const enough = c.balance >= c.need && c.balance >= reserve;
  log(`  balance is ${enough ? 'ENOUGH' : 'NOT enough'} (needs ${formatEther(c.need > reserve ? c.need : reserve)} ETH)`);
  log(`  expected duration: Mode A ~${(100 * 12) / 60}–${(100 * 24) / 60} min, finality ~13–20 min more, Mode B a few minutes`);
}

// ── the benchmark ────────────────────────────────────────────
const sumRow = (name: string, s: Summary | null, d = 1) => (s ? `| ${name} | ${s.n} | ${s.mean.toFixed(d)} | ${s.median.toFixed(d)} | ${s.p95.toFixed(d)} | ${s.min.toFixed(d)} | ${s.max.toFixed(d)} | ${s.sd.toFixed(d)} |` : `| ${name} | 0 | | | | | | |`);
const SUM_HEAD = '| | n | mean | median | p95 | min | max | SD |\n|---|---:|---:|---:|---:|---:|---:|---:|';

async function runBench(chain: ChainName) {
  const startedAt = new Date().toISOString();
  const work = loadCredentials();
  const art = loadArtifact();
  log(`E2 on ${chain}: ${work.files.length} credentials (${work.totalBytes} bytes of JWT), contract ${art.compiler}`);

  let node: LocalNode | null = null, rpcUrl: string, wallet: Wallet, pollMs: number, paceMs: number, rpcLabel: string, usingDefaultRpc = false;
  let tool: { name: string; version: string; client: string };
  let sepoliaPreflight: Awaited<ReturnType<typeof sepoliaContext>> | null = null;
  if (chain !== 'sepolia') {
    node = await startLocalNode(8599, chain === 'local-amsterdam' ? 'hardhat3-amsterdam' : 'hardhat2');
    rpcUrl = node.url; wallet = new Wallet(DEV_KEY); pollMs = 1; paceMs = 0; rpcLabel = `${node.url} (started by this script)`;
    tool = { name: node.tool, version: node.version, client: node.clientVersion };
    log(`local node: ${node.clientVersion} (hardhat ${node.version}, hardfork: ${node.hardfork}${node.edrVersion ? `, EDR ${node.edrVersion}` : ''}) at ${node.url}`);
  } else {
    sepoliaPreflight = await sepoliaContext();
    if (sepoliaPreflight.balance < sepoliaPreflight.need) die(`balance ${formatEther(sepoliaPreflight.balance)} ETH is below the estimated need ${formatEther(sepoliaPreflight.need)} ETH: run --dry-run, fund ${sepoliaPreflight.wallet.address}, then try again`);
    rpcUrl = sepoliaPreflight.url; wallet = sepoliaPreflight.wallet; pollMs = 1000; paceMs = SEPOLIA_PACE_MS;
    usingDefaultRpc = sepoliaPreflight.usingDefaultRpc; rpcLabel = `${origin(rpcUrl)}${usingDefaultRpc ? ' (public default)' : ' (SEPOLIA_RPC_URL)'}`;
    tool = { name: 'Sepolia public test network', version: '', client: await sepoliaPreflight.rpc.send<string>('web3_clientVersion').catch(() => 'unknown') };
    log(`Sepolia via ${rpcLabel}; wallet ${wallet.address} balance ${formatEther(sepoliaPreflight.balance)} ETH`);
  }

  try {
    const rpc = sepoliaPreflight?.rpc ?? new JsonRpc(rpcUrl);
    const chainId = BigInt(await rpc.send('eth_chainId'));
    log('reading mainnet gas price and ETH/USD (read only, nothing paid)...');
    const feeCtx = await mainnetFeeContext();
    for (const e of feeCtx.errors) log(`  ! ${e}`);

    // nonces: read the pending count once, then count locally (a load-balanced RPC can answer from a lagging backend)
    const baseNonce = Number(BigInt(await rpc.send('eth_getTransactionCount', [wallet.address, 'pending'])));
    const plan = planNonces(baseNonce, work.files.length);
    log(`nonces (read once, then counted here): deploy ${plan.deploy}, Mode A ${plan.modeAStart}..${plan.modeBStart - 1}, Mode B ${plan.modeBStart}..${plan.next - 1}`);
    const expectedCode = await runtimeCode(rpc, wallet.address, art.bytecode);
    if (!expectedCode || expectedCode === '0x') throw new Error('could not obtain the runtime code of the contract (eth_call of the creation code returned nothing)');

    // deploy
    log('deploying...');
    const dfees = await currentFees(rpc);
    const dep = await deployContract(rpc, wallet, chainId, art, dfees, pollMs, plan.deploy);
    log(`  deployed at ${dep.address}: ${(dep.ms).toFixed(0)} ms, gas ${dep.gasUsed} (estimate ${dep.gasEstimate}, limit ${dep.gasLimit})`);

    // wait until the node answers with the deployed code, then estimate record() once; before Mode A, outside every timing
    log('  waiting until the deployed code is visible (3 equal reads of eth_getCode)...');
    const codeReads = await waitForCode(rpc, dep.address, expectedCode, { pollMs: chain === 'sepolia' ? 2000 : 20 });
    log(`  code visible after ${codeReads} reads`);
    const recordCall = { from: wallet.address, to: dep.address, data: new Interface(art.abi as any).encodeFunctionData('record', [GAS_ESTIMATE_HASH]) };
    const liveEstimate = await estimateGas(rpc, recordCall);
    const ov = await estimateRecordWithOverride(rpc, wallet.address, art);
    const overrideEstimate = ov.overridden ? ov.gas : null;
    const pick = chooseRecordGas(liveEstimate, overrideEstimate);
    if (pick.warn) log(`  ! WARNING: the estimate on the live contract (${liveEstimate}) is below half of the state-override estimate (${overrideEstimate}): the node may be lagging; using the larger value`);
    const recordEstimate = pick.gas;
    const recordLimit = gasLimitFrom(recordEstimate);
    log(`  record() estimate: live ${liveEstimate}, state override ${overrideEstimate ?? 'not available'} -> using ${recordEstimate}, gas limit ${recordLimit}`);

    const mkChain = async () => new WalletChain(rpc, wallet, dep.address, chainId, await currentFees(rpc), pollMs, art.abi, recordLimit);

    // Mode A
    log('Mode A: one after another...');
    const chainA = await mkChain();
    const A = await modeA(chainA, work.hashesA, plan.modeAStart, (i, r) => { if (i % 10 === 9 || i === 0) log(`  ${i + 1}/100  last ${ms1(r.ms)} ms`); });

    // finality (Sepolia)
    let fin: Awaited<ReturnType<typeof waitFinality>> | null = null;
    if (chain === 'sepolia') {
      log('waiting for finality of the Mode A transactions (polling the "finalized" tag every 12 s)...');
      let n = 0;
      fin = await waitFinality(rpc, A.map((r) => ({ blockNumber: r.blockNumber, sentAt: r.sentAt })), 12_000, 90 * 60_000, (f, p) => { if (n++ % 5 === 0) log(`  finalized block ${f}, ${p} of 100 still waiting`); });
    }

    // Mode B
    log(`Mode B: all at once, at most ${WINDOW} waiting...`);
    const chainB = await mkChain();
    const B = await modeB(chainB, work.hashesB, plan.modeBStart, WINDOW);
    log(`  ${B.results.length} included in ${(B.wallMs / 1000).toFixed(2)} s (${B.throughput.toFixed(2)} per second), most waiting at once: ${B.maxWaiting}`);

    // check
    log('check: recordedAt for each fingerprint...');
    const chk = await timedRecordedAt(rpc, dep.address, art.abi, work.hashesA, paceMs);
    const chkB = await timedRecordedAt(rpc, dep.address, art.abi, work.hashesB, paceMs);
    const recordedA = chk.timestamps.filter((t) => t > 0n).length, recordedB = chkB.timestamps.filter((t) => t > 0n).length;
    if (recordedA !== 100 || recordedB !== 100) die(`not all fingerprints are recorded: Mode A ${recordedA}/100, Mode B ${recordedB}/100`);

    // summaries
    const timeA = summarize(A.map((r) => r.ms)), timeB = summarize(B.results.map((r) => r.ms));
    const gasA = summarize(A.map((r) => r.gasUsed)), gasB = summarize(B.results.map((r) => r.gasUsed));
    const timeFin = fin ? summarize(fin.ms) : null, timeChk = summarize(chk.ms);
    const gasMedian = gasA!.median;
    const fee = feeCtx.gas ? { perCredential: feeOf(gasMedian, feeCtx.gas.gasPriceWei, feeCtx.price?.usd ?? null), deploy: feeOf(dep.gasUsed, feeCtx.gas.gasPriceWei, feeCtx.price?.usd ?? null) } : null;

    const cpus = os.cpus();
    const environment = { cpu: cpus[0]?.model.trim(), cores: cpus.length, ramGB: Math.round((os.totalmem() / 2 ** 30) * 10) / 10, os: `${os.platform()} ${os.release()}`, node: process.version };
    const result = {
      startedAt, label: LABEL, chain, chainId: chainId.toString(), tool, rpc: rpcLabel, environment,
      contract: { name: art.contract, compiler: art.compiler, sourceSha256: art.sourceSha256 },
      workload: { credentials: work.files.length, directory: path.relative('.', CREDS).split(path.sep).join('/'), totalJwtBytes: work.totalBytes, modeBHashing: 'SHA-256("modeB\\n" + JWT), because a hash can be recorded only once' },
      params: { window: WINDOW, receiptPollMs: pollMs, requestPaceMsInCheck: paceMs, finalityPollMs: chain === 'sepolia' ? 12_000 : null },
      gas: {
        rules: node ? node.hardfork : SEPOLIA_RULES,
        deploy: { estimate: dep.gasEstimate.toString(), limit: dep.gasLimit.toString(), estimatedFrom: 'eth_estimateGas from the wallet with the contract creation code, before the timed send' },
        record: { estimate: recordEstimate.toString(), liveEstimate: liveEstimate.toString(), overrideEstimate: overrideEstimate?.toString() ?? null, lowLiveEstimateWarning: pick.warn, limit: recordLimit.toString(), estimatedFrom: `the larger of eth_estimateGas on the deployed contract (live) and eth_estimateGas with a state override, for record() with an unused fingerprint (SHA-256 of "gas-estimate"), after the deployed code was seen and before Mode A` },
        nonces: { baseReadOnce: baseNonce, deploy: plan.deploy, modeAFirst: plan.modeAStart, modeBFirst: plan.modeBStart, codeReadsBeforeEstimate: codeReads, note: 'nonces are counted locally; the node is asked once, before the deploy' },
        limitRule: 'gas limit = ceil(estimate × 1.25); only the gas used is charged',
        note: GAS_NOTE,
      },
      engine: node ? { hardhat: node.version, edr: node.edrVersion, hardfork: node.hardfork, supportedAmsterdamEips: node.supportedEips, eipSource: node.supportedEips ? 'https://hardhat.org/docs/reference/amsterdam-support (the page names no Hardhat version)' : null } : null,
      deploy: { address: dep.address, txHash: dep.txHash, ms: dep.ms, gasUsed: dep.gasUsed, blockNumber: dep.blockNumber },
      modeA: { ms: timeA, gasUsed: gasA, wallSeconds: (A[A.length - 1].includedAt - A[0].sentAt) / 1000, transactions: A.map((r) => ({ file: work.files[r.index], hash: r.hash, txHash: r.txHash, nonce: r.nonce, ms: r.ms, blockNumber: r.blockNumber, gasUsed: r.gasUsed, effectiveGasPriceWei: r.effectiveGasPrice.toString() })) },
      modeB: { ms: timeB, gasUsed: gasB, wallSeconds: B.wallMs / 1000, throughputPerSecond: B.throughput, maxWaiting: B.maxWaiting, transactions: B.results.map((r) => ({ file: work.files[r.index], hash: r.hash, txHash: r.txHash, nonce: r.nonce, ms: r.ms, blockNumber: r.blockNumber, gasUsed: r.gasUsed, effectiveGasPriceWei: r.effectiveGasPrice.toString() })) },
      finality: fin ? { ms: timeFin, polls: fin.polls, finalizedBlockAtEnd: fin.finalizedBlock, perCredentialMs: fin.ms } : null,
      check: { ms: timeChk, recordedModeA: recordedA, recordedModeB: recordedB, perCredentialMs: chk.ms },
      backoff: { retries: rpc.retries, backoffMsExcluded: rpc.backoffMs, requests: rpc.requests },
      mainnetFees: {
        gas: feeCtx.gas && { rpc: feeCtx.gas.rpc, baseFeeGwei: gwei(feeCtx.gas.baseFeeWei), tipGwei: gwei(feeCtx.gas.tipWei), gasPriceGwei: gwei(feeCtx.gas.gasPriceWei), at: feeCtx.gas.at },
        ethUsd: feeCtx.price, errors: feeCtx.errors,
        basisGas: gasMedian, perCredential: fee?.perCredential ?? null, deploy: fee?.deploy ?? null,
      },
      links: chain === 'sepolia' ? { contract: `https://sepolia.etherscan.io/address/${dep.address}`, sampleTransactions: [A[0].txHash, A[A.length - 1].txHash].map((h) => `https://sepolia.etherscan.io/tx/${h}`) } : null,
    };

    const md = report(result, fee, feeCtx, usingDefaultRpc);
    fs.mkdirSync('output/bench', { recursive: true });
    const stamp = startedAt.replace(/:/g, '-');
    const base = `output/bench/e2-${chain}-${stamp}`;
    fs.writeFileSync(`${base}.json`, JSON.stringify(result, null, 1));
    fs.writeFileSync(`${base}.md`, md);
    log(`\n${md}\nsaved ${base}.json and .md`);
    if (result.links) {
      log(`\nEtherscan (Sepolia):\n  contract ${result.links.contract}`);
      for (const l of result.links.sampleTransactions) log(`  transaction ${l}`);
    }
  } finally {
    await node?.stop();
  }
}

// ── report ───────────────────────────────────────────────────
function report(r: any, fee: { perCredential: { gwei: number; eth: number; usd: number | null }; deploy: { gwei: number; eth: number; usd: number | null } } | null, feeCtx: Awaited<ReturnType<typeof mainnetFeeContext>>, usingDefaultRpc: boolean): string {
  const isSep = r.chain === 'sepolia';
  const kindText = isSep ? 'the Sepolia test network' : r.chain === 'local-amsterdam' ? 'a local development chain with the Amsterdam hardfork' : 'a local development chain';
  const eth = (x: number) => (x < 1e-4 ? x.toExponential(3) : x.toFixed(6));
  const usd = (x: number | null) => (x === null ? 'n/a' : `$${x < 0.01 ? x.toFixed(4) : x.toFixed(2)}`);
  const sec = (x: number) => (x < 1000 ? `${x.toFixed(1)} ms` : `${(x / 1000).toFixed(2)} s`);
  const fmtFee = (f: { gwei: number; eth: number; usd: number | null }) => `${f.gwei.toFixed(0)} gwei = ${eth(f.eth)} ETH = ${usd(f.usd)}`;
  const finalRows = [
    `| Time until a score is accepted | none: signing is local (E1) | Mode A median ${sec(r.modeA.ms.median)} (p95 ${sec(r.modeA.ms.p95)})${r.finality ? `; until finalized: median ${sec(r.finality.ms.median)} (p95 ${sec(r.finality.ms.p95)})` : ''} |`,
    `| Fee per score | none: no chain | ${fee ? `${Math.round(r.modeA.gasUsed.median)} gas; at mainnet prices ${fmtFee(fee.perCredential)}` : `${Math.round(r.modeA.gasUsed.median)} gas (mainnet price lookup failed: fees in gas only)`} |`,
    `| Time to check a score | signature and DID checks, offline or online (E1) | recordedAt median ${r.check.ms.median.toFixed(2)} ms (p95 ${r.check.ms.p95.toFixed(2)} ms); shows only that the fingerprint was recorded |`,
    `| Scores per second (Mode B) | issuing throughput (E1) | ${r.modeB.throughputPerSecond.toFixed(2)} per second (${r.modeB.wallSeconds.toFixed(2)} s for 100, at most ${r.params.window} waiting) |`,
  ];
  return `# E2 — Fingerprints of the 100 signed credentials on ${kindText}

${r.label} Started ${r.startedAt}. Chain id ${r.chainId}. ${r.tool.name}${r.tool.version ? ` ${r.tool.version}` : ''}${r.tool.client ? ` (client: ${r.tool.client})` : ''}. RPC: ${r.rpc}. Contract ${r.contract.name} compiled with ${r.contract.compiler} (source SHA-256 ${r.contract.sourceSha256.slice(0, 16)}…).
Machine: ${r.environment.cpu}, ${r.environment.cores} threads, ${r.environment.ramGB} GB, ${r.environment.os}, Node ${r.environment.node}.

Workload: the ${r.workload.credentials} signed credentials in \`${r.workload.directory}\` (${r.workload.totalJwtBytes} bytes of JWT). Each fingerprint is the SHA-256 of the JWT string. ${isSep ? '' : 'This is the best case for a blockchain: one node, no network consensus, a block for every transaction. '}Receipts are polled every ${r.params.receiptPollMs} ms, so inclusion times have that resolution. Rate-limit backoff is left out of every timing (${r.backoff.retries} retries, ${(r.backoff.backoffMsExcluded / 1000).toFixed(1)} s excluded).

## Summary: DIDcal against a blockchain registry (${r.label.toLowerCase().replace(/\.$/, '')})

| | DIDcal | Blockchain registry (${r.chain}) |
|---|---|---|
${finalRows.join('\n')}

## Gas limits and gas rules

Rules the chain follows: **${r.gas.rules}**.${r.engine ? ` Hardhat ${r.engine.hardhat}${r.engine.edr ? `, EDR ${r.engine.edr}` : ''}.` : ''}

| | Estimate (gas) | Gas limit (gas) | Gas used | Estimated by |
|---|---:|---:|---:|---|
| deploy | ${r.gas.deploy.estimate} | ${r.gas.deploy.limit} | ${r.deploy.gasUsed} | ${r.gas.deploy.estimatedFrom} |
| record() | ${r.gas.record.estimate} (live ${r.gas.record.liveEstimate}, state override ${r.gas.record.overrideEstimate ?? 'n/a'}${r.gas.record.lowLiveEstimateWarning ? ', live estimate was suspiciously low' : ''}) | ${r.gas.record.limit} | ${Math.round(r.modeA.gasUsed.median)} (median, Mode A) | ${r.gas.record.estimatedFrom} |

Limit rule: ${r.gas.limitRule}. ${r.gas.note}
${r.engine?.supportedAmsterdamEips ? `\nAmsterdam EIPs that Hardhat ${r.engine.hardhat} supports, according to ${r.engine.eipSource} (experimental and incomplete there):\n\n${r.engine.supportedAmsterdamEips.map((e: string) => `- ${e}`).join('\n')}\n` : ''}
## One-time: deploy

| Time until included | Gas used | Address |
|---:|---:|---|
| ${sec(r.deploy.ms)} | ${r.deploy.gasUsed} | ${r.deploy.address} |

## Mode A — one after another (each waits for its receipt)

Time per credential from send until included in a block (ms), and gas per credential.

${SUM_HEAD}
${sumRow('time until included (ms)', r.modeA.ms)}
${sumRow('gas used', r.modeA.gasUsed, 0)}

Total wall time for 100: ${r.modeA.wallSeconds.toFixed(2)} s.

## Mode B — all at once (consecutive nonces, at most ${r.params.window} waiting)

Time per credential from its own send until included (ms). Under rate limits, backoff by other waiting transactions may be subtracted too.

${SUM_HEAD}
${sumRow('time until included (ms)', r.modeB.ms)}
${sumRow('gas used', r.modeB.gasUsed, 0)}

Throughput: 100 / ${r.modeB.wallSeconds.toFixed(2)} s (first send to last inclusion) = **${r.modeB.throughputPerSecond.toFixed(2)} credentials per second**. Most waiting at once: ${r.modeB.maxWaiting}.
${r.finality ? `
## Finality (Sepolia)

Time from each Mode A send until its block was finalized, polling the "finalized" tag every 12 s (resolution 12 s; ${r.finality.polls} polls).

${SUM_HEAD}
${sumRow('time until finalized (ms)', r.finality.ms, 0)}
` : ''}
## Check — recordedAt (eth_call)

${SUM_HEAD}
${sumRow('recordedAt call (ms)', r.check.ms, 2)}

All ${r.check.recordedModeA} Mode A fingerprints (and all ${r.check.recordedModeB} Mode B fingerprints) are recorded. **This only shows that the fingerprint was recorded on the chain. It does not replace checking the credential's signature, its issuer's DID or its sources.**

## Fees at mainnet prices (nothing was paid)

${fee && feeCtx.gas ? `Gas price ${gwei(feeCtx.gas.gasPriceWei)} gwei (base fee ${gwei(feeCtx.gas.baseFeeWei)} + tip ${gwei(feeCtx.gas.tipWei)}), read from ${feeCtx.gas.rpc} at ${feeCtx.gas.at}. ${feeCtx.price ? `ETH/USD ${feeCtx.price.usd} from ${feeCtx.price.source} at ${feeCtx.price.at}.` : 'The ETH/USD lookup failed: no dollar figures.'}

| | Gas | gwei | ETH | USD |
|---|---:|---:|---:|---:|
| per credential (median of Mode A) | ${Math.round(r.modeA.gasUsed.median)} | ${fee.perCredential.gwei.toFixed(0)} | ${eth(fee.perCredential.eth)} | ${usd(fee.perCredential.usd)} |
| deploy (once) | ${r.deploy.gasUsed} | ${fee.deploy.gwei.toFixed(0)} | ${eth(fee.deploy.eth)} | ${usd(fee.deploy.usd)} |
| all 100 credentials | ${Math.round(r.modeA.gasUsed.median) * 100} | ${(fee.perCredential.gwei * 100).toFixed(0)} | ${eth(fee.perCredential.eth * 100)} | ${usd(fee.perCredential.usd === null ? null : fee.perCredential.usd * 100)} |
` : `The mainnet gas price lookup failed, so fees are reported in gas only: ${Math.round(r.modeA.gasUsed.median)} gas per credential, ${r.deploy.gasUsed} gas to deploy.`}
${feeCtx.errors.length ? `\nLookup problems: ${feeCtx.errors.join('; ')}.\n` : ''}
## Notes

- Mode B records a second set of fingerprints, SHA-256("modeB\\n" + JWT), because the contract rejects a hash that is already recorded; the gas is the same.
- Times are wall-clock from the benchmark process and include signing and the RPC round trips.${isSep && usingDefaultRpc ? ' The RPC is a shared public endpoint, so its latency varies.' : ''}
`;
}

// ── main ─────────────────────────────────────────────────────
async function main() {
  if (CHAIN !== 'local' && CHAIN !== 'local-amsterdam' && CHAIN !== 'sepolia') die('usage: npx tsx src/bench/e2.ts --chain=local | --chain=local-amsterdam | --chain=sepolia [--new-wallet | --dry-run | --yes]');
  if (flag('new-wallet')) { if (CHAIN !== 'sepolia') die('--new-wallet is for --chain=sepolia'); return newWallet(); }
  if (CHAIN === 'sepolia') {
    if (flag('dry-run')) return dryRun();
    if (!flag('yes')) die('A real Sepolia run needs --yes. Use --dry-run first to see the balance and the estimated need. Nothing was sent.');
  }
  await runBench(CHAIN as ChainName);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
