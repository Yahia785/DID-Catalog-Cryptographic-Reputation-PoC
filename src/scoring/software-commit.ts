import { execFileSync } from 'node:child_process';

/**
 * Which software produced a credential: the git commit at issuance, and whether the scoring code
 * paths had uncommitted changes then. A "dirty" credential was made by code that is not exactly
 * the commit it names; the formula's own code is pinned separately by its codeHash.
 */
export const SCORING_PATHS = ['src/scoring', 'src/shared', 'src/verification'];

export interface SoftwareCommit { commit: string; dirty: boolean }

export function softwareCommit(): SoftwareCommit {
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  return { commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain', '--', ...SCORING_PATHS).length > 0 };
}
