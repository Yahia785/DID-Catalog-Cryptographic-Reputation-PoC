import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../scoring/formula-releases.js';
import { decodeScoreVC, type DecodedScoreVC } from '../scoring/read-vc.js';

/**
 * Cohort consistency across one run (--run-dir): the credentials of a folder were all ranked against
 * the same sample.
 *
 *   (1) all credentials of the same venue type carry the same cohort id and identical values;
 *   (2) for each cohort indicator, the sorted cohort values equal the sorted list of that indicator's
 *       input values across the run's credentials of that type.
 *
 * LIMIT: this proves consistency WITHIN the run only. It does not prove that the run is complete (a
 * platform could leave venues out of the folder and of the cohort together) or that the sample was
 * selected fairly; the cohort is only as good as the venues the platform chose to put in it.
 * The signatures of the credentials are not checked here (use demo:verify --all for that).
 */

export interface RunCohortResult {
  status: 'pass' | 'fail';
  credentials: number;
  perType: { type: string; credentials: number; cohortId: string | null; indicators: Record<string, number> }[];
  problems: string[];
}

/** "conf.scimago.hIndex" → the input metric "scimago.hIndex"; "journal.scimago.sjr" → "scimago.sjr". */
const metricOf = (indicator: string) => indicator.replace(/^(conf|journal)\./, '');

export function checkRunCohorts(dir: string): RunCohortResult {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.vc.jwt')).sort();
  const creds: DecodedScoreVC[] = files.map((f) => decodeScoreVC(fs.readFileSync(path.join(dir, f), 'utf8')));
  const problems: string[] = [];
  const perType: RunCohortResult['perType'] = [];
  if (!creds.length) return { status: 'fail', credentials: 0, perType, problems: [`no *.vc.jwt credentials in ${dir}`] };

  for (const type of ['conference', 'journal'] as const) {
    const ofType = creds.filter((c) => c.manifest.venueType === type);
    if (!ofType.length) continue;
    const withCohort = ofType.filter((c) => c.manifest.cohort);
    for (const c of ofType.filter((x) => !x.manifest.cohort)) problems.push(`${type} ${c.manifest.venueKey}: the credential carries no cohort`);
    if (!withCohort.length) { perType.push({ type, credentials: ofType.length, cohortId: null, indicators: {} }); continue; }

    // (1) one cohort id, one content
    const ref = withCohort[0].manifest.cohort!;
    const refJson = canonicalJson(ref);
    for (const c of withCohort) {
      const co = c.manifest.cohort!;
      if (co.id !== ref.id) problems.push(`${type} ${c.manifest.venueKey}: cohort id ${co.id} differs from ${ref.id} (${withCohort[0].manifest.venueKey})`);
      else if (canonicalJson(co) !== refJson) problems.push(`${type} ${c.manifest.venueKey}: same cohort id ${co.id} but different values`);
    }

    // (2) each indicator's cohort values are exactly the run's input values of that type
    const indicators: Record<string, number> = {};
    for (const [name, values] of Object.entries(ref.values)) {
      indicators[name] = values.length;
      const metric = metricOf(name);
      const fromRun: { key: string; value: number }[] = [];
      for (const c of withCohort) {
        const v = c.manifest.inputs.find((i) => i.metric === metric)?.value;
        if (typeof v === 'number' && Number.isFinite(v)) fromRun.push({ key: c.manifest.venueKey, value: v });
      }
      if (values.some((v, i) => i > 0 && values[i - 1] > v)) problems.push(`${type} ${name}: the cohort values are not sorted`);
      const remaining = new Map<number, { key: string }[]>();
      for (const r of fromRun) remaining.set(r.value, [...(remaining.get(r.value) ?? []), { key: r.key }]);
      const unmatched: number[] = [];
      for (const v of values) {
        const bucket = remaining.get(v);
        if (bucket?.length) bucket.pop(); else unmatched.push(v);
      }
      for (const v of unmatched) problems.push(`${type} ${name}: the cohort has the value ${v}, but no credential in the run has it as ${metric}`);
      for (const [v, bucket] of remaining) for (const b of bucket) problems.push(`${type} ${name}: ${b.key}'s ${metric} ${v} is not in the cohort`);
    }
    perType.push({ type, credentials: ofType.length, cohortId: ref.id, indicators });
  }
  return { status: problems.length ? 'fail' : 'pass', credentials: creds.length, perType, problems };
}
