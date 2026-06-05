/**
 * Merge Guardian CLI (EPIC 012). Evaluates a branch against main and prints a
 * verdict. Evaluation only — it never merges or pushes anything.
 *
 *   npm run guardian -- <branch> [base] [--ci passing|failing]
 *
 * Example: npm run guardian -- feat/foo main --ci passing
 */
import { buildSnapshotFromGit, evaluatePr } from '../services/merge-guardian';
import { formatGuardian } from '../services/merge-guardian/format';
import { CiStatus } from '../src/types';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const branch = args[0];
const base = args[1] ?? 'main';
const ciIdx = process.argv.indexOf('--ci');
const ci = (ciIdx >= 0 ? process.argv[ciIdx + 1] : 'unknown') as CiStatus;

if (!branch) {
  console.error('Usage: npm run guardian -- <branch> [base] [--ci passing|failing]');
  process.exit(1);
}

const snapshot = buildSnapshotFromGit(branch, base, ci);
const report = evaluatePr(snapshot);
// Strip HTML for console output.
console.log(formatGuardian(report).replace(/<[^>]+>/g, ''));
