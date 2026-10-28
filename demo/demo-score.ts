import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';
import { readScoreVC, SCORES_DIR, type DecodedScoreVC } from '../src/scoring/read-vc.js';
import { computeScore, FORMULAS } from '../src/scoring/compute-score.js';
import { VENUES, findVenue, handleOf } from '../src/venues/registry.js';

/**
 * npm run demo:score              leaderboard of all signed scores
 * npm run demo:score -- SCN       detail card for one venue: every sub-score with
 *                                 its raw inputs, source file and SHA-256
 * Add --dir=output/scores/f1 to show the formula 1.0 credentials (class and points) instead.
 *
 * Everything shown is read from the SIGNED credentials (output/scores/*.vc.jwt),
 * not from separate files, so what you see is exactly what was signed.
 */

const DIR = path.resolve(process.argv.find((a) => a.startsWith('--dir='))?.split('=')[1] ?? SCORES_DIR);

const fmt = (x: number | null, digits = 2) => (x === null ? chalk.gray('—'.padStart(5)) : x.toFixed(digits).padStart(5));
const colorScore = (s: number | null) =>
  s === null ? chalk.gray('  —  ') : (s >= 70 ? chalk.green : s >= 40 ? chalk.yellow : chalk.red)(s.toFixed(1).padStart(5));
const short = (did: string) => `${did.slice(0, 16)}…${did.slice(-4)}`;

function loadAll(): DecodedScoreVC[] {
  return VENUES.filter((v) => fs.existsSync(path.join(DIR, `${v.slug}.vc.jwt`))).map((v) => readScoreVC(v.slug, DIR));
}

const CLASS_ORDER = ['A++', 'A+', 'A', 'A-', 'B', 'B-', 'C', 'Work in progress', '200', '140', '100', '70', '40', '20', 'Not rated'];

/** Formula 1.0: a class and points, no 0–1 sub-scores. */
function leaderboard1(all: DecodedScoreVC[]) {
  const m = all[0].manifest;
  console.log(chalk.bold('\nDIDcal venue classes (formula 1.0)'));
  console.log(chalk.gray(`issuer ${all[0].claims.iss}   ${m.cohort ? `cohorts: ${[...new Set(all.map((vc) => vc.manifest.cohort?.id))].join(', ')}` : ''}\n`));
  for (const type of ['conference', 'journal'] as const) {
    const rows = all.filter((vc) => vc.subject.venueType === type)
      .sort((a, b) => CLASS_ORDER.indexOf(a.subject.class ?? '') - CLASS_ORDER.indexOf(b.subject.class ?? '') || (b.subject.score ?? -1) - (a.subject.score ?? -1));
    console.log(chalk.bold(`${type === 'journal' ? 'JOURNALS (Polish method: band, points = higher percentile)' : 'CONFERENCES (GGS rating: class, points = class scores)'}`));
    console.log(chalk.gray('  Venue        Class              Points  Src   Flags'));
    for (const vc of rows) {
      const s = vc.subject;
      console.log(`  ${vc.manifest.venueKey.padEnd(12)} ${chalk.bold(String(s.class).padEnd(18))} ${s.score === null ? '   —  ' : s.score.toFixed(1).padStart(6)}  ${s.confidence.present}/${s.confidence.total}   ${chalk.yellow(s.flags.join(' · '))}`);
    }
    console.log();
  }
  console.log(chalk.gray('Ranks are within the sample (the cohort inside each credential). Details: npm run demo:score -- <venue> --dir=...\n'));
}

function detail1(vc: DecodedScoreVC, venueKey: string) {
  const { subject: s, manifest: m } = vc;
  const venue = findVenue(venueKey)!;
  const working = FORMULAS['1.0'].compute(s.venueType, m.inputs, m.cohort).explain;
  console.log(chalk.bold(`\n${venue.key} — ${venue.name}`));
  console.log(`${chalk.gray('DID')}      ${chalk.cyan(s.venue)}   ${chalk.gray(handleOf(venue))}`);
  console.log(`${chalk.gray('Type')}     ${s.venueType}   ${chalk.gray(`(${venue.role})`)}`);
  console.log(`${chalk.gray('Class')}    ${chalk.bold(String(s.class))}    ${chalk.gray('points')} ${s.score ?? '—'}    ${chalk.gray('sources')} ${s.confidence.present} of ${s.confidence.total}`);
  if (s.flags.length) console.log(`${chalk.gray('Flags')}    ${chalk.yellow(s.flags.join(' · '))}`);
  console.log(chalk.bold('\nWorking (recomputed from the signed inputs and cohort)'));
  for (const [k, v] of Object.entries(working)) console.log(`  ${k.padEnd(22)} ${chalk.magenta(v)}`);
  console.log(chalk.bold('\nBreakdown (signed)'));
  for (const [k, v] of Object.entries(s.breakdown)) console.log(`  ${k.padEnd(22)} ${v ?? '—'}`);
  if (m.cohort) {
    console.log(chalk.bold('\nCohort (signed)') + chalk.gray(`  ${m.cohort.id}${m.cohort.populationSize ? `, population ${m.cohort.populationSize}` : ''}`));
    for (const [k, v] of Object.entries(m.cohort.values)) console.log(`  ${k.padEnd(38)} ${v.length} values`);
  }
  console.log(chalk.bold('\nSources'));
  for (const x of m.sources) console.log(`  ${x.id.padEnd(17)} ${x.name}${x.edition ? ` (${x.edition})` : ''}  ${chalk.gray(x.sha256 ? `sha256 ${x.sha256.slice(0, 16)}…` : x.file)}`);
  console.log(chalk.bold('\nCredential'));
  console.log(`  issuer (platform)  ${chalk.cyan(vc.claims.iss)}`);
  console.log(`  subject (venue)    ${chalk.cyan(vc.claims.sub)}`);
  console.log(`  formula            ${m.formulaVersion}, computed ${s.computedAt}`);
  console.log(`  signed VC          ${path.relative('.', path.join(DIR, `${venue.slug}.vc.jwt`))}  ${chalk.gray(`(${vc.jwt.length} bytes, manifest and cohort embedded)`)}`);
  console.log(chalk.gray(`\nVerify it: npm run demo:verify -- ${venue.key} --dir=${path.relative('.', DIR)}\n`));
}

function leaderboard() {
  const all = loadAll();
  if (!all.length) throw new Error('No signed scores found. Run: npm run score');
  if (all[0].manifest.formulaVersion === '1.0') return leaderboard1(all);
  const m = all[0].manifest;
  console.log(chalk.bold('\nDIDcal venue scores'));
  console.log(chalk.gray(`formula ${m.formulaVersion}   snapshot ${path.dirname(m.sources[0].file)}   issuer ${all[0].claims.iss}\n`));

  for (const type of ['journal', 'conference'] as const) {
    const rows = all.filter((vc) => vc.subject.venueType === type)
      .sort((a, b) => (b.subject.score ?? -1) - (a.subject.score ?? -1));
    console.log(chalk.bold(`${type === 'journal' ? 'JOURNALS' : 'CONFERENCES'}`.padEnd(12)) +
      chalk.gray(' Score  Conf  Standing Impact Stability Integrity  Venue DID              Flags'));
    for (const vc of rows) {
      const s = vc.subject, b = s.breakdown as Record<string, number | null>; // 0.1-demo sub-scores
      console.log(
        `${vc.manifest.venueKey.padEnd(12)} ${colorScore(s.score)}  ${s.confidence.present}/${s.confidence.total}  ` +
        `${fmt(b.standing)}    ${fmt(b.impact)}  ${fmt(b.stability)}     ${fmt(b.integrity)}     ` +
        `${chalk.cyan(short(s.venue))}  ${chalk.yellow(s.flags.join(' · '))}`);
    }
    console.log();
  }
  console.log(chalk.gray('Scores are 0–100 (placeholder formula). "—" = no data, left out of the average (never counted as zero).'));
  console.log(chalk.gray('Details for one venue: npm run demo:score -- <venue>     Verify: npm run demo:verify -- <venue>\n'));
}

function detail(key: string) {
  const venue = findVenue(key);
  if (!venue) throw new Error(`Unknown venue "${key}". Try one of: ${VENUES.map((v) => v.key).join(', ')}`);
  const vc = readScoreVC(venue.slug, DIR);
  if (vc.manifest.formulaVersion === '1.0') return detail1(vc, key);
  const { subject: s0, manifest: m } = vc;
  const s = { ...s0, breakdown: s0.breakdown as Record<string, number | null> }; // 0.1-demo sub-scores
  const input = (metric: string) => m.inputs.find((i) => i.metric === metric);
  const val = (metric: string) => input(metric)?.value ?? null;
  const src = (id: string) => m.sources.find((x) => x.id === id);
  const srcLine = (id: string) => {
    const x = src(id);
    return x ? chalk.gray(`source: ${x.name}${x.edition ? ` (${x.edition})` : ''} · ${x.file}`) : chalk.gray(`source: ${id} (not in snapshot)`);
  };
  const series = (prefix: string) => m.inputs.filter((i) => i.metric.startsWith(`${prefix}.`)).map((i) => `${i.metric.slice(prefix.length + 1)}:${i.value ?? '—'}`).join(' ');

  console.log(chalk.bold(`\n${venue.key} — ${venue.name}`));
  console.log(`${chalk.gray('DID')}      ${chalk.cyan(s.venue)}   ${chalk.gray(handleOf(venue))}`);
  console.log(`${chalk.gray('Type')}     ${s.venueType}   ${chalk.gray(`(${venue.role})`)}`);
  console.log(`${chalk.gray('Score')}    ${colorScore(s.score)} / 100   confidence ${s.confidence.present} of ${s.confidence.total} sub-scores`);
  if (s.flags.length) console.log(`${chalk.gray('Flags')}    ${chalk.yellow(s.flags.join(' · '))}`);
  console.log();

  // Re-run the formula on the signed inputs, only to show the working (the same function the verifier uses)
  const working = computeScore(s.venueType, m.inputs).explain;
  const calcOf: Record<string, string> = { Standing: working.standing, Impact: working.impact, Stability: working.stability, Integrity: working.integrity };

  const block = (name: string, value: number | null, lines: string[], sourceIds: string[]) => {
    console.log(`${chalk.bold(name.padEnd(10))} ${fmt(value, 3)}`);
    for (const l of lines) console.log(`           data:  ${l}`);
    console.log(`           calc:  ${chalk.magenta(calcOf[name])}`);
    for (const id of sourceIds) console.log(`           ${srcLine(id)}`);
    console.log();
  };

  if (s.venueType === 'conference') {
    block('Standing', s.breakdown.standing, [`ICORE rank: ${val('icore.rank') ?? 'not listed'}`], ['icore']);
    const p = val('s2.cohortPapers') as number | null, c = val('s2.cohortCitations') as number | null;
    block('Impact', s.breakdown.impact, [`${val('s2.cohortYear') ?? '—'} papers: ${p ?? '—'}, their citations: ${c ?? '—'}${p && c !== null ? ` (${(c / p).toFixed(1)} per paper)` : ''}`], ['s2']);
    block('Stability', s.breakdown.stability, [`papers per year: ${series('s2.papers')}`], ['s2']);
  } else {
    block('Standing', s.breakdown.standing, [`SCImago best quartile: ${val('scimago.quartile') ?? 'not listed'}`], ['scimago']);
    block('Impact', s.breakdown.impact, [`2-yr mean citedness: ${typeof val('openalex.twoYrMeanCitedness') === 'number' ? (val('openalex.twoYrMeanCitedness') as number).toFixed(2) : '—'}`], ['openalex']);
    block('Stability', s.breakdown.stability, [`papers per year: ${series('openalex.works')}`], ['openalex']);
  }
  const ret = val('rw.retractions') as number | null;
  const works = val('openalex.worksCount') as number | null;
  block('Integrity', s.breakdown.integrity,
    [s.venueType === 'journal' && works ? `${ret ?? '—'} retractions / ${works} papers${ret !== null ? ` (${((ret / works) * 1000).toFixed(1)} per 1,000)` : ''}`
      : `${ret ?? '—'} retractions${ret === 0 && s.venueType === 'conference' ? ' (zero carries no signal for conferences)' : ''}`],
    ['retraction-watch']);

  console.log(`${chalk.bold('Score'.padEnd(10))} ${colorScore(s.score)}`);
  console.log(`           calc:  ${chalk.magenta(working.score)}`);

  console.log(chalk.bold('\nCredential'));
  console.log(`  issuer (platform)  ${chalk.cyan(vc.claims.iss)}   ${chalk.gray(`https://plc.directory/${vc.claims.iss}`)}`);
  console.log(`  subject (venue)    ${chalk.cyan(vc.claims.sub)}   ${chalk.gray(`https://plc.directory/${vc.claims.sub}`)}`);
  console.log(`  formula            ${m.formulaVersion}, computed ${s.computedAt}`);
  console.log(`  signed VC          ${path.join('output', 'scores', `${venue.slug}.vc.jwt`)}  ${chalk.gray(`(${vc.jwt.length} bytes, manifest embedded)`)}`);
  console.log(`  readable manifest  ${path.join('output', 'scores', `${venue.slug}.manifest.json`)}`);
  console.log(chalk.gray(`\nVerify it: npm run demo:verify -- ${venue.key}\n`));
}

try {
  const key = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? process.argv.find((a) => a.startsWith('--venue='))?.split('=')[1];
  key ? detail(key) : leaderboard();
} catch (e) {
  console.error(chalk.red(e instanceof Error ? e.message : e));
  process.exit(1);
}
