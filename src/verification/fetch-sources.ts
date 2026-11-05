import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';
import { contentHash } from '../scoring/extract-1.js';
import { decodeScoreVC } from '../scoring/read-vc.js';
import type { ProvenanceManifest } from '../shared/types.js';
import { assertNotOwnData } from './check-inputs.js';
import { downloadTo, icoreExportUrl, rwRawUrl, SCIMAGO_PAGE, type Download } from './provider-urls.js';

/**
 * npx tsx src/verification/fetch-sources.ts --dir=<credentials folder> --out=<folder>
 *
 * Fetch the provider files a reader needs for the Inputs check (demo:verify --sources-dir=<folder>), as
 * named by the credentials:
 *   ICORE            the CSV export of the credentials' edition (icore.csv)
 *   Retraction Watch the file at the commit pinned in the credentials (retraction_watch.csv), downloaded
 *                    from the raw URL with the commit SHA; its SHA-256 is compared with the credentials'
 *   SCImago          cannot be fetched from a script (the site asks a browser to pass a Cloudflare check):
 *                    the manual steps are printed
 * It never writes into data/ (the issuer's own copies): --out inside data/ is refused. Every download is
 * timed; the timings go to output/bench/fetch-sources-<ISO>.json.
 */

export interface FetchPlan {
  icore?: { edition: string; url: string; sha256?: string; contentHash?: string };
  retractionWatch?: { commit: string; url: string; sha256?: string };
  scimago?: { edition?: string };
  notes: string[];       // things a reader should know (several editions, no pinned commit, ...)
}

const uniq = <T>(xs: (T | undefined)[]) => [...new Set(xs.filter((x): x is T => x !== undefined))];

/** What to fetch, from the sources named in a set of credentials. */
export function planFetches(manifests: ProvenanceManifest[]): FetchPlan {
  const plan: FetchPlan = { notes: [] };
  const src = (id: string) => manifests.flatMap((m) => m.sources.filter((s) => s.id === id));

  const ic = src('icore');
  const editions = uniq(ic.map((s) => s.edition));
  if (editions.length === 1) {
    plan.icore = { edition: editions[0], url: icoreExportUrl(editions[0]), sha256: uniq(ic.map((s) => s.sha256))[0], contentHash: uniq(ic.map((s) => s.contentHash))[0] };
  } else plan.notes.push(editions.length ? `the credentials name several ICORE editions (${editions.join(', ')}): fetch each into its own folder by hand` : 'the credentials name no ICORE edition');

  const rw = src('retraction-watch');
  const commits = uniq(rw.map((s) => (s.match?.commit as string | undefined)));
  if (commits.length === 1) plan.retractionWatch = { commit: commits[0], url: rwRawUrl(commits[0]), sha256: uniq(rw.map((s) => s.sha256))[0] };
  else if (commits.length > 1) plan.notes.push(`the credentials pin several Retraction Watch commits (${commits.map((c) => c.slice(0, 8)).join(', ')}): fetch each into its own folder by hand`);
  else if (rw.length) plan.notes.push('these credentials do not pin a Retraction Watch commit: download the latest retraction_watch.csv from https://gitlab.com/crossref/retraction-watch-data (the check then counts the rows dated up to the credentials\' cutoff)');

  const sc = src('scimago');
  if (sc.length) plan.scimago = { edition: uniq(sc.map((s) => s.edition))[0] };
  return plan;
}

export interface FetchedFile { source: string; file: string; url: string; bytes: number; ms: number; sha256: string; sameBytesAsCredentials: boolean | null; sameContentAsCredentials: boolean | null }

/** Fetch what the plan lists into `out`; `download` is injectable for tests. */
export async function fetchSources(credsDir: string, out: string, download: typeof downloadTo = downloadTo): Promise<{ plan: FetchPlan; files: FetchedFile[]; manualSteps: string[] }> {
  const outDir = assertNotOwnData(out);          // never into data/
  const manifests = fs.readdirSync(credsDir).filter((f) => f.endsWith('.vc.jwt')).map((f) => decodeScoreVC(fs.readFileSync(path.join(credsDir, f), 'utf8')).manifest);
  if (!manifests.length) throw new Error(`no *.vc.jwt credentials in ${credsDir}`);
  const plan = planFetches(manifests);
  fs.mkdirSync(outDir, { recursive: true });
  const files: FetchedFile[] = [];
  const keep = (source: string, d: Download, expectSha?: string, expectContent?: string, text?: string) => files.push({
    source, file: d.file, url: d.url, bytes: d.bytes, ms: d.ms, sha256: d.sha256,
    sameBytesAsCredentials: expectSha ? d.sha256 === expectSha : null,
    sameContentAsCredentials: expectContent && text !== undefined ? contentHash('icore', text) === expectContent : null,
  });

  if (plan.icore) {
    const file = path.join(outDir, 'icore.csv');
    const d = await download(plan.icore.url, file);
    keep('icore', d, plan.icore.sha256, plan.icore.contentHash, fs.readFileSync(file, 'utf8'));
  }
  if (plan.retractionWatch) {
    const d = await download(plan.retractionWatch.url, path.join(outDir, 'retraction_watch.csv'));
    keep('retraction-watch', d, plan.retractionWatch.sha256);
  }
  const manualSteps = plan.scimago ? [
    `SCImago cannot be downloaded by a script. By hand, in a browser:`,
    `  1. open ${SCIMAGO_PAGE}`,
    `  2. set Year to ${plan.scimago.edition?.match(/\d{4}/)?.[0] ?? '(the edition year)'}; leave subject area, category, country and type on "all"`,
    `  3. click "Download data" above the table`,
    `  4. save the file as ${path.join(out, 'scimago.csv')}`,
  ] : [];
  return { plan, files, manualSteps };
}


async function main() {
  const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
  const [dir, out] = [arg('dir'), arg('out')];
  if (!dir || !out) throw new Error('usage: npx tsx src/verification/fetch-sources.ts --dir=<credentials folder> --out=<folder>');
  const startedAt = new Date().toISOString();
  const { plan, files, manualSteps } = await fetchSources(dir, out);

  console.log(chalk.bold(`\nProvider files for the credentials in ${dir} → ${out}\n`));
  for (const f of files) {
    const same = f.sameBytesAsCredentials === null ? '' : f.sameBytesAsCredentials ? chalk.green('  same bytes as the credentials') : chalk.yellow('  different bytes from the credentials');
    const content = f.sameContentAsCredentials === null ? '' : f.sameContentAsCredentials ? chalk.green('  same content') : chalk.yellow('  different content');
    console.log(`  ${chalk.green('✓')} ${f.source.padEnd(17)} ${String(f.bytes).padStart(9)} bytes in ${(f.ms / 1000).toFixed(1)} s  sha256 ${f.sha256.slice(0, 16)}…${same}${content}`);
    console.log(chalk.gray(`      ${f.url}`));
  }
  for (const n of plan.notes) console.log(chalk.yellow(`  ! ${n}`));
  if (manualSteps.length) { console.log(); for (const l of manualSteps) console.log(l); }

  fs.mkdirSync('output/bench', { recursive: true });
  const file = `output/bench/fetch-sources-${startedAt.replace(/:/g, '-')}.json`;
  fs.writeFileSync(file, JSON.stringify({ startedAt, credentials: dir, out, plan, files, notes: plan.notes }, null, 1));
  console.log(chalk.gray(`\ntimings saved to ${file}\nNext: npx tsx demo/demo-verify.ts --all --dir=${dir} --sources-dir=${out}\n`));
}

if (process.argv[1]?.split(path.sep).join('/').endsWith('src/verification/fetch-sources.ts')) {
  main().catch((e) => { console.error(chalk.red(e instanceof Error ? e.message : e)); process.exit(1); });
}
