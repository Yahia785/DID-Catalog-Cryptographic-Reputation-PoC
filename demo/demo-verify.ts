import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';
import { summarize, type Summary } from '../src/bench/stats.js';
import { SCORES_DIR, vcPathFor } from '../src/scoring/read-vc.js';
import { ProviderFiles, providerFilesFor, SOURCE_FILES, type SourceInputsResult, type SourceStatus } from '../src/verification/check-inputs.js';
import { checkRunCohorts } from '../src/verification/check-run.js';
import { resolverFor, verifyScoreJwt, type Check, type VerifyReport } from '../src/verification/verify-score.js';
import { VENUES, findVenue } from '../src/venues/registry.js';

/**
 * npm run demo:verify -- SCN           verify one venue's signed score, step by step
 * npm run demo:verify -- --all         verify every venue (one line each)
 * npm run demo:verify -- --file=path   verify any score VC file (e.g. one someone sent you)
 * Add --dir=output/scores/f1 to use the formula 1.0 credentials instead of output/scores/.
 * Add --offline to read the cached audit logs in output/plc-cache/ (see: npm run cache:plc) instead of plc.directory.
 *
 * Add --sources-dir=PATH for the sixth check, Inputs (L3): the inputs are compared with the provider's OWN
 * files in PATH (icore.csv, scimago.csv, retraction_watch.csv) that you downloaded yourself; a folder inside
 * data/ is refused. A per-source table is printed for each credential and totals at the end.
 * Add --run-dir=PATH to check that the credentials in PATH were all ranked against one and the same cohort.
 * Add --bench (with --sources-dir and --all) to time the Inputs check: file read / hash / parse, per-venue
 * extraction and the whole check per credential, saved to output/bench/inputs-check-<ISO>.json
 * (--repeat=N, default 5, repeats the file loading to get a spread).
 */

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const DIR = path.resolve(arg('dir') ?? SCORES_DIR);
const SOURCES_DIR = arg('sources-dir');
const RUN_DIR = arg('run-dir');
const BENCH = process.argv.includes('--bench');

const icon: Record<Check['status'], string> = {
  pass: chalk.green('✓'), fail: chalk.red('✗'), warn: chalk.yellow('⚠'), skip: chalk.gray('–'),
};
const sourceIcon: Record<SourceStatus, string> = {
  pass: chalk.green('pass'), warn: chalk.yellow('warn'), fail: chalk.red('fail'), 'not-verifiable': chalk.gray('not-verifiable'),
};

/** The per-source rows of the Inputs check. */
function printInputsTable(sources: SourceInputsResult[]) {
  for (const s of sources) {
    console.log(`      ${s.source.padEnd(17)} ${sourceIcon[s.status].padEnd(s.status === 'not-verifiable' ? 23 : 14)} ${s.title ? chalk.cyan(`[${s.title}] `) : ''}${chalk.gray(s.reason)}`);
  }
}

export function printReport(r: VerifyReport, title?: string) {
  if (title) console.log(chalk.bold(`\n${title}`));
  console.log(chalk.gray(`${r.venueKey}  venue ${r.venueDID}  issuer ${r.issuer}`));
  for (const c of r.checks) {
    // the Inputs check has its own per-source table instead of one long line
    console.log(`  ${icon[c.status]} ${c.name.padEnd(22)} ${c.name === 'Inputs' && r.inputs ? chalk.gray(`${c.status === 'skip' ? 'nothing could be checked against a provider file' : c.status}`) : chalk.gray(c.detail)}`);
    if (c.name === 'Inputs' && r.inputs) printInputsTable(r.inputs.sources);
  }
  console.log(r.ok ? chalk.green.bold(`  → VALID: ${r.class ? `class ${r.class}, points ${r.score}` : `score ${r.score}`} is authentic and reproducible`) : chalk.red.bold('  → INVALID: do not trust this score'));
}

function printRunCohorts(dir: string): boolean {
  const r = checkRunCohorts(dir);
  console.log(chalk.bold(`\nCohort consistency across the run in ${path.relative('.', dir) || dir}`));
  for (const t of r.perType) console.log(`  ${t.type.padEnd(11)} ${String(t.credentials).padStart(3)} credentials  cohort ${t.cohortId ?? 'none'}  ${Object.entries(t.indicators).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  for (const p of r.problems) console.log(chalk.red(`  ✗ ${p}`));
  console.log(r.status === 'pass'
    ? chalk.green.bold('  → CONSISTENT: every credential of a type carries the same cohort, and each cohort indicator equals the run\'s input values')
    : chalk.red.bold(`  → INCONSISTENT: ${r.problems.length} problem(s)`));
  console.log(chalk.gray('  (consistency within this run only: it does not show that the run is complete or that the sample was chosen fairly)'));
  return r.status === 'pass';
}

async function main() {
  const resolver = resolverFor(process.argv.includes('--offline'));
  const file = arg('file');
  const sourcesDir = SOURCES_DIR ? providerFilesFor(SOURCES_DIR) : undefined;   // refuses a folder inside data/
  if (BENCH && (!sourcesDir || !process.argv.includes('--all'))) throw new Error('--bench needs --all and --sources-dir');

  let cohortOk = true;
  if (RUN_DIR) {
    cohortOk = printRunCohorts(path.resolve(RUN_DIR));
    if (!process.argv.includes('--all') && !file && !process.argv.slice(2).some((a) => !a.startsWith('--'))) process.exit(cohortOk ? 0 : 1);
  }

  if (process.argv.includes('--all')) {
    console.log(chalk.bold('\nVerifying all signed scores\n'));
    let failed = 0;
    const totals = new Map<string, Record<SourceStatus, number>>();
    const inputsMs: number[] = [];
    const extractMs = new Map<string, number[]>();
    for (const v of VENUES) {
      if (!fs.existsSync(vcPathFor(v.slug, DIR))) continue;
      const timings: { inputsMs?: number } = {};
      const r = await verifyScoreJwt(fs.readFileSync(vcPathFor(v.slug, DIR), 'utf8'), { resolver, sourcesDir, timings });
      if (!r.ok) failed++;
      let sourcesText = '';
      if (r.inputs) {
        inputsMs.push(timings.inputsMs ?? r.inputs.ms);
        sourcesText = '  ' + r.inputs.sources.map((s) => `${s.source}:${sourceIcon[s.status]}`).join(' ');
        for (const s of r.inputs.sources) {
          const t = totals.get(s.source) ?? { pass: 0, warn: 0, fail: 0, 'not-verifiable': 0 };
          t[s.status]++;
          totals.set(s.source, t);
          if (s.extractMs !== undefined) extractMs.set(s.source, [...(extractMs.get(s.source) ?? []), s.extractMs]);
        }
      }
      console.log(`  ${r.ok ? chalk.green('✓') : chalk.red('✗')} ${v.key.padEnd(9)} ${r.checks.map((c) => icon[c.status]).join(' ')}  ${chalk.gray(r.checks.filter((c) => c.status !== 'pass').map((c) => c.name).join(', '))}${sourcesText}`);
      if (r.inputs && r.inputs.sources.some((s) => s.status === 'fail' || s.status === 'warn')) {
        for (const s of r.inputs.sources.filter((x) => x.status === 'fail' || x.status === 'warn')) console.log(`      ${chalk.gray(`${s.source}: ${s.reason}`)}`);
      }
    }
    console.log(chalk.gray(`\n  checks: signature · identities · venue · recompute · formula${sourcesDir ? ' · inputs' : ''}`));
    if (totals.size) {
      console.log(chalk.bold('\nInputs check, totals per source across all credentials'));
      console.log('  ' + 'source'.padEnd(18) + ['pass', 'warn', 'fail', 'not-verifiable'].map((h) => h.padStart(15)).join(''));
      for (const [source, t] of totals) console.log('  ' + source.padEnd(18) + [t.pass, t.warn, t.fail, t['not-verifiable']].map((n) => String(n).padStart(15)).join(''));
    }
    if (BENCH && sourcesDir) await benchInputs(sourcesDir, inputsMs, extractMs);
    console.log(failed ? chalk.red(`\n${failed} credential(s) failed\n`) : chalk.green('\nAll credentials valid\n'));
    process.exit(failed || !cohortOk ? 1 : 0);
  }

  let jwt: string;
  if (file) jwt = fs.readFileSync(file, 'utf8');
  else {
    const key = process.argv.slice(2).find((a) => !a.startsWith('--'));
    const venue = key ? findVenue(key) : undefined;
    if (!venue) throw new Error(`Give a venue (${VENUES.map((v) => v.key).join(', ')}), --all, or --file=path`);
    jwt = fs.readFileSync(vcPathFor(venue.slug, DIR), 'utf8');
  }
  const r = await verifyScoreJwt(jwt, { resolver, sourcesDir });
  printReport(r, 'Verifying score credential');
  console.log();
  process.exit(r.ok && cohortOk ? 0 : 1);
}

/** Benchmark of the Inputs check: file read / hash / parse (repeated for a spread), per-venue extraction, whole check per credential. */
async function benchInputs(files: ProviderFiles, inputsMs: number[], extractMs: Map<string, number[]>) {
  const repeat = Math.max(1, Number(arg('repeat') ?? 5) || 5);
  const perFile: Record<string, { readMs: number[]; hashMs: number[]; parseMs: number[]; bytes: number }> = {};
  for (let i = 0; i < repeat; i++) {
    const fresh = new ProviderFiles(files.dir);   // nothing cached: every load reads, hashes and parses again
    for (const source of Object.keys(SOURCE_FILES) as (keyof typeof SOURCE_FILES)[]) {
      const f = fresh.load(source);
      if (!f) continue;
      const p = (perFile[source] ??= { readMs: [], hashMs: [], parseMs: [], bytes: f.bytes });
      p.readMs.push(f.readMs); p.hashMs.push(f.hashMs); p.parseMs.push(f.parseMs);
    }
  }
  const sum = (xs: number[]) => summarize(xs);
  const result = {
    startedAt: new Date().toISOString(), credentials: inputsMs.length, repeat, sourcesDir: files.dir,
    files: Object.fromEntries(Object.entries(perFile).map(([s, p]) => [s, { bytes: p.bytes, readMs: sum(p.readMs), hashMs: sum(p.hashMs), parseMs: sum(p.parseMs) }])),
    extractionPerVenueMs: Object.fromEntries([...extractMs].map(([s, xs]) => [s, sum(xs)])),
    inputsCheckPerCredentialMs: sum(inputsMs),
  };
  fs.mkdirSync('output/bench', { recursive: true });
  const out = `output/bench/inputs-check-${result.startedAt.replace(/:/g, '-')}.json`;
  fs.writeFileSync(out, JSON.stringify(result, null, 1));

  const f = (x: number, d = 3) => x.toFixed(d);
  const row = (name: string, s: Summary | null | undefined) => s && console.log('  ' + name.padEnd(36) + [String(s.n), f(s.mean), f(s.median), f(s.p95), f(s.min), f(s.max)].map((x) => x.padStart(10)).join(''));
  console.log(chalk.bold('\nInputs check cost (ms)'));
  console.log('  ' + 'metric'.padEnd(36) + ['n', 'mean', 'median', 'p95', 'min', 'max'].map((h) => h.padStart(10)).join(''));
  for (const [s, p] of Object.entries(result.files)) { row(`${s} file read (${(p.bytes / 1e6).toFixed(1)} MB)`, p.readMs); row(`${s} hash`, p.hashMs); row(`${s} parse`, p.parseMs); }
  for (const [s, x] of Object.entries(result.extractionPerVenueMs)) row(`${s} extraction per venue`, x);
  row('whole Inputs check per credential', result.inputsCheckPerCredentialMs);
  console.log(chalk.gray(`  saved to ${out}`));
}

if (process.argv[1]?.includes('demo-verify')) {
  main().catch((e) => { console.error(chalk.red(e instanceof Error ? e.message : e)); process.exit(1); });
}
