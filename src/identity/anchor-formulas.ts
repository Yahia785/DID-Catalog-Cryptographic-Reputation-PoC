import * as atprotoCrypto from '@atproto/crypto';
import * as dagCbor from '@ipld/dag-cbor';
import chalk from 'chalk';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { ANCHOR_SERVICE_KEY, anchorHeadOf, anchorService, chainProblems, loadReleases, recordHash } from '../scoring/formula-releases.js';
import { extractOperationFields, fetchCurrentOperation, signUpdateOperation } from './claim-venue.js';
import { loadPlatform } from './identity-store.js';

/**
 * Anchor the head of the formula release chain in the platform DID.
 *
 *   npx tsx src/identity/anchor-formulas.ts           dry run: build and check the update, print the diff, publish nothing
 *   npx tsx src/identity/anchor-formulas.ts --live    publish it to plc.directory (once), timed
 *
 * The update operation copies rotationKeys, verificationMethods, alsoKnownAs and services from the
 * platform DID's current operation exactly and only adds (or replaces) services.didcal_formulas =
 * { type: DIDcalFormulaReleases, endpoint: https://didcal.io/formulas#sha256=<head> }; prev is the
 * CID of the current operation; it is signed by the platform rotation key. It stops without
 * publishing if anything other than that service would change.
 */

const live = process.argv.includes('--live');
const POLL_MS = 250, POLL_MAX_MS = 30_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  const platform = loadPlatform();
  const list = loadReleases();
  if (!list) throw new Error('releases/formula-releases.json not found: run npx tsx src/scoring/release-formulas.ts');
  if (list.platform !== platform.did) throw new Error(`the release list belongs to ${list.platform}, not to the platform ${platform.did}`);
  const broken = chainProblems(list.records.map((r) => r.record));
  if (broken.length) throw new Error(`the release chain is broken: ${broken.join('; ')}`);
  const head = recordHash(list.records[list.records.length - 1].record);

  console.log(chalk.bold(`\n=== Anchor the formula release chain in ${platform.did} (${live ? 'LIVE' : 'dry run'}) ===\n`));
  console.log(`chain head  ${head}   (${list.records.length} records: ${list.records.map((r) => r.record.formulaVersion).join(' → ')})`);

  // current state: the last operation of the platform DID
  const entry = (await fetchCurrentOperation(platform.did)) as { operation: Record<string, unknown>; cid?: string; createdAt?: string };
  if (typeof entry.cid !== 'string') throw new Error('plc.directory returned no cid for the current operation');
  const current = extractOperationFields(entry);
  const currentAnchor = anchorHeadOf((current.services as Record<string, unknown>)?.[ANCHOR_SERVICE_KEY]);
  if (currentAnchor === head) { console.log(chalk.green('\nThis head is already anchored in the current operation. Nothing to do.\n')); return; }

  const rotationKey = await atprotoCrypto.Secp256k1Keypair.import(platform.rotationKeyPair.privateKey, { exportable: false });
  if (!(current.rotationKeys as string[]).includes(rotationKey.did())) throw new Error('the platform rotation key is not in the DID\'s current rotationKeys: cannot sign an update');

  // the new operation: everything copied, one service added
  const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x));
  const unsigned = {
    type: current.type,
    rotationKeys: copy(current.rotationKeys),
    verificationMethods: copy(current.verificationMethods),
    alsoKnownAs: copy(current.alsoKnownAs),
    services: { ...copy(current.services as Record<string, unknown>), [ANCHOR_SERVICE_KEY]: anchorService(head) },
    prev: entry.cid,
  };

  // field-by-field diff; only services may differ (prev always moves to the current operation's CID)
  console.log(chalk.bold('\nDiff: current operation → new operation'));
  const problems: string[] = [];
  for (const f of ['type', 'rotationKeys', 'verificationMethods', 'alsoKnownAs'] as const) {
    const ok = same(current[f], unsigned[f]);
    console.log(`  ${f.padEnd(20)} ${ok ? chalk.green('identical') : chalk.red('DIFFERENT')}   ${JSON.stringify(unsigned[f])}`);
    if (!ok) problems.push(f);
  }
  const oldServices = current.services as Record<string, unknown>;
  for (const k of new Set([...Object.keys(oldServices), ...Object.keys(unsigned.services)])) {
    const was = oldServices[k], now = (unsigned.services as Record<string, unknown>)[k];
    const state = same(was, now) ? chalk.green('identical') : was === undefined ? chalk.yellow('ADDED') : chalk.yellow('CHANGED');
    console.log(`  ${('services.' + k).padEnd(20)} ${state}   ${JSON.stringify(now)}${was !== undefined && !same(was, now) ? chalk.gray(`   (was ${JSON.stringify(was)})`) : ''}`);
    if (k !== ANCHOR_SERVICE_KEY && !same(was, now)) problems.push(`services.${k}`);
  }
  console.log(`  ${'prev'.padEnd(20)} ${chalk.yellow('moves')}       ${current.prev === null ? 'null' : String(current.prev).slice(0, 20) + '…'} → ${entry.cid}  (the CID of the current operation, created ${entry.createdAt})`);
  if (problems.length) throw new Error(`STOP: ${problems.join(', ')} would differ; only services.${ANCHOR_SERVICE_KEY} may change. Nothing was published.`);

  // sign and check the signature locally
  const t0 = performance.now();
  const signed = await signUpdateOperation(unsigned as Record<string, unknown>, rotationKey);
  const signMs = performance.now() - t0;
  const sigOk = await atprotoCrypto.verifySignature(rotationKey.did(), dagCbor.encode(unsigned), Buffer.from(signed.sig as string, 'base64url'));
  console.log(`\nsigned by the platform rotation key ${rotationKey.did().slice(0, 30)}… in ${signMs.toFixed(1)} ms; local signature check: ${sigOk ? chalk.green('valid') : chalk.red('INVALID')}`);
  if (!sigOk) throw new Error('the signature does not verify locally; not publishing');
  const body = JSON.stringify(signed);
  console.log(`request body ${Buffer.byteLength(body)} bytes`);

  if (!live) { console.log(chalk.yellow('\nDry run: nothing published. Add --live to publish this update once.\n')); return; }

  // publish
  const startedAt = new Date().toISOString();
  const t1 = performance.now();
  const res = await fetch(`https://plc.directory/${platform.did}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  const text = await res.text();
  const postMs = performance.now() - t1;
  if (!res.ok) throw new Error(`plc.directory update failed (${res.status}): ${text}`);
  console.log(chalk.green(`\nPOST ${res.status} in ${postMs.toFixed(0)} ms (${Buffer.byteLength(text)} bytes back)`));

  // wait until the audit log shows the new operation
  const t2 = performance.now();
  let polls = 0, newEntry: { cid: string; createdAt: string } | null = null, auditBytes = 0;
  for (;;) {
    polls++;
    const r = await fetch(`https://plc.directory/${platform.did}/log/audit`, { headers: { Accept: 'application/json' } });
    if (r.ok) {
      const t = await r.text();
      const log = JSON.parse(t) as { cid: string; createdAt: string; operation: { services?: Record<string, unknown> } }[];
      const hit = log.find((e) => anchorHeadOf(e.operation.services?.[ANCHOR_SERVICE_KEY]) === head);
      if (hit) { newEntry = hit; auditBytes = Buffer.byteLength(t); break; }
    }
    if (performance.now() - t2 > POLL_MAX_MS) break;
    await sleep(POLL_MS);
  }
  const appearMs = performance.now() - t2;
  if (!newEntry) throw new Error(`the update was accepted but did not show in /log/audit within ${POLL_MAX_MS / 1000} s`);
  console.log(chalk.green(`audit log shows it after ${appearMs.toFixed(0)} ms (${polls} poll(s)); cid ${newEntry.cid}, createdAt ${newEntry.createdAt}`));

  fs.mkdirSync('output/bench', { recursive: true });
  const file = `output/bench/formula-anchor-${startedAt.replace(/:/g, '-')}.json`;
  fs.writeFileSync(file, JSON.stringify({
    startedAt, did: platform.did, head, records: list.records.map((r) => r.record.formulaVersion),
    signMs, postMs, httpStatus: res.status, requestBytes: Buffer.byteLength(body), responseBytes: Buffer.byteLength(text),
    timeUntilInAuditLogMs: appearMs, polls, auditLogBytesAfter: auditBytes, newOperationCid: newEntry.cid, createdAt: newEntry.createdAt,
    previousOperationCid: entry.cid,
  }, null, 1));
  console.log(chalk.gray(`saved to ${file}\nNext: npm run cache:plc\n`));
}

main().catch((e) => { console.error(chalk.red(e instanceof Error ? e.message : e)); process.exit(1); });
