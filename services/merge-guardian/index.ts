import { execSync } from 'child_process';
import {
  GuardianChecklistItem,
  MergeGuardianReport,
  MergeVerdict,
  PolicyFinding,
  PrSnapshot,
} from '../../src/types';

/**
 * Merge Guardian (EPIC 012).
 *
 * Evaluates a PR snapshot against a safety policy and returns a verdict:
 * SAFE_TO_AUTO_MERGE / REQUIRES_HUMAN_REVIEW / BLOCKED, plus a risk score,
 * reasons, required human actions, blocked reasons and a checklist.
 *
 * EVALUATION + REPORTING ONLY. It never merges, pushes, approves, or changes
 * any GitHub setting — real auto-merge stays disabled. The engine is pure;
 * `buildSnapshotFromGit` is a best-effort local helper for the CLI/bot.
 */

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

// ── Path policy ──────────────────────────────────────────────────────────────

/** Touching these → at least REQUIRES_HUMAN_REVIEW, with the given reason. */
const PROTECTED_PATHS: { re: RegExp; reason: string }[] = [
  { re: /^src\/moderation-actions\.ts$/, reason: 'moderation/publish flow touched' },
  { re: /^services\/telegram-sender\//, reason: 'publish (channel sender) flow touched' },
  { re: /^src\/pipeline\.ts$/, reason: 'pipeline flow touched' },
  { re: /^src\/draft-store\.ts$/, reason: 'draft lifecycle store touched' },
  { re: /^services\/scoring-layer\//, reason: 'scoring thresholds/logic changed' },
  { re: /^services\/verification-engine\//, reason: 'verification formulas changed' },
  { re: /^services\/content-engine\//, reason: 'content-generation behavior changed' },
  { re: /^services\/(affiliate-layer|exchange-registry)\//, reason: 'affiliate/registry logic changed' },
  { re: /^apps\/telegram-bot\//, reason: 'bot commands changed' },
  { re: /^config\//, reason: 'runtime config changed' },
  { re: /^(ecosystem\.config\.js|package\.json)$/, reason: 'deployment/build config changed' },
  { re: /^\.github\//, reason: 'CI workflow changed' },
];

/** Paths that count as "publish safety" — removals here are extra-sensitive. */
const PUBLISH_SAFETY_RE = /^(src\/moderation-actions\.ts|services\/telegram-sender\/|apps\/telegram-bot\/)/;

const isDoc = (f: string) => /\.md$/.test(f) || f.startsWith('docs/');
const isTest = (f: string) => /^tests\//.test(f) || /\.test\.ts$/.test(f);
const isEnvFile = (f: string) => /(^|\/)\.env($|\.(?!example))/.test(f) || f === '.env';

// ── Content scanners ─────────────────────────────────────────────────────────

const SECRET_PATTERNS: { re: RegExp; what: string }[] = [
  { re: /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/, what: 'Telegram bot token' },
  { re: /\bsk-[A-Za-z0-9]{20,}\b/, what: 'OpenAI API key' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, what: 'AWS access key' },
  { re: /-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----/, what: 'private key' },
  { re: /\bTELEGRAM_BOT_TOKEN\s*=\s*\S+/, what: 'hardcoded bot token' },
];

const AUTO_PUBLISH_PATTERNS: { re: RegExp; what: string }[] = [
  { re: /auto[_-]?publish/i, what: 'auto-publish' },
  { re: /auto[_-]?approve/i, what: 'auto-approve' },
  { re: /autonomous[_-]?(post|publish|merge)/i, what: 'autonomous posting' },
  { re: /publishToChannel\([^)]*\)\s*;?\s*\/\/\s*auto/i, what: 'unattended publishToChannel' },
];

/** Safety markers whose REMOVAL is a red flag. */
const SAFETY_MARKERS = ['humanReviewRequired', 'requireEnv', 'isAdmin(', 'inFlight', 'manual Approve', 'reportGate'];

function addedLines(diff: string): string[] {
  return diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
}
function removedLines(diff: string): string[] {
  return diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'));
}

// ── Core policy ──────────────────────────────────────────────────────────────

export function evaluatePr(pr: PrSnapshot, now = new Date()): MergeGuardianReport {
  const findings: PolicyFinding[] = [];
  const add = (id: string, level: PolicyFinding['level'], message: string) =>
    findings.push({ id, level, message });

  const files = pr.changedFiles;
  const codeFiles = files.filter((f) => !isDoc(f) && !isTest(f));

  // --- BLOCK: committed env / secrets ---------------------------------------
  for (const f of files) if (isEnvFile(f)) add('env_committed', 'block', `Environment file committed: ${f}`);
  if (pr.diffText) {
    const added = addedLines(pr.diffText).join('\n');
    for (const s of SECRET_PATTERNS) if (s.re.test(added)) add('secret', 'block', `Possible ${s.what} in diff`);
    for (const a of AUTO_PUBLISH_PATTERNS) if (a.re.test(added)) add('auto_publish', 'block', `Auto-publish/approve code detected (${a.what})`);
    // Publish-safety removal
    const removed = removedLines(pr.diffText).join('\n');
    const touchesPublish = files.some((f) => PUBLISH_SAFETY_RE.test(f));
    if (touchesPublish) {
      for (const m of SAFETY_MARKERS) {
        if (removed.includes(m)) add('safety_removed', 'block', `Publish/moderation safety marker removed: "${m}"`);
      }
    }
  }

  // --- BLOCK: CI / conflicts -------------------------------------------------
  if (pr.ciStatus === 'failing') add('ci_failing', 'block', 'CI is failing');
  if (pr.mergeConflicts) add('conflicts', 'block', 'Merge conflicts with base branch');

  // --- REVIEW: protected paths ----------------------------------------------
  const seenReasons = new Set<string>();
  for (const f of files) {
    for (const p of PROTECTED_PATHS) {
      if (p.re.test(f) && !seenReasons.has(p.reason)) {
        seenReasons.add(p.reason);
        add('protected_path', 'review', p.reason);
      }
    }
  }

  // --- REVIEW: CI unknown, tests, size, staleness ---------------------------
  if (pr.ciStatus === 'unknown') add('ci_unknown', 'review', 'CI status unknown — confirm checks passed');
  if (codeFiles.length > 0 && !pr.hasTests) add('no_tests', 'review', 'Code changed without accompanying tests');
  const diffSize = pr.additions + pr.deletions;
  if (diffSize > 2000) add('huge_diff', 'review', `Very large diff (${diffSize} lines)`);
  else if (diffSize > 800) add('large_diff', 'review', `Large diff (${diffSize} lines)`);
  if (pr.behindBy > 20) add('stale_behind', 'review', `Branch is ${pr.behindBy} commits behind ${pr.baseBranch}`);
  if (pr.ageDays > 30) add('stale_age', 'review', `Branch is ${pr.ageDays} days old`);
  if (codeFiles.length > 0 && !pr.readmeUpdated) add('no_readme', 'review', 'Code changed without README/docs update');

  // --- Verdict ---------------------------------------------------------------
  const blockedReasons = findings.filter((f) => f.level === 'block').map((f) => f.message);
  const reviewReasons = findings.filter((f) => f.level === 'review').map((f) => f.message);

  const docsOnly = files.length > 0 && files.every(isDoc);
  const testsOnly = files.length > 0 && files.every(isTest);

  let verdict: MergeVerdict;
  if (blockedReasons.length) verdict = 'BLOCKED';
  else if (reviewReasons.length || pr.ciStatus !== 'passing') verdict = 'REQUIRES_HUMAN_REVIEW';
  else verdict = 'SAFE_TO_AUTO_MERGE'; // docs/tests-only or isolated new service, CI passing, nothing protected

  // --- Risk score ------------------------------------------------------------
  let risk = 0;
  risk += reviewReasons.length * 14;
  if (diffSize > 800) risk += 15;
  if (pr.behindBy > 20 || pr.ageDays > 30) risk += 15;
  if (pr.ciStatus === 'unknown') risk += 10;
  if (blockedReasons.length) risk = Math.max(risk, 90);
  if (verdict === 'SAFE_TO_AUTO_MERGE') risk = Math.min(risk, 15);
  const riskScore = clamp(Math.round(risk), 0, 100);

  // --- Required human actions ------------------------------------------------
  const requiredHumanActions: string[] = [];
  if (verdict === 'BLOCKED') requiredHumanActions.push('Resolve all blocking issues before this PR can be considered.');
  if (reviewReasons.length) requiredHumanActions.push('A human must review the flagged areas and approve manually.');
  if (pr.ciStatus !== 'passing') requiredHumanActions.push('Ensure CI is green.');
  if (docsOnly && verdict === 'SAFE_TO_AUTO_MERGE') requiredHumanActions.push('None — docs-only, low risk (auto-merge still disabled by policy).');

  const checklist: GuardianChecklistItem[] = [
    { name: 'CI passing', ok: pr.ciStatus === 'passing', note: pr.ciStatus },
    { name: 'No .env committed', ok: !files.some(isEnvFile), note: '' },
    { name: 'No secrets in diff', ok: !findings.some((f) => f.id === 'secret'), note: '' },
    { name: 'No auto-publish/approve code', ok: !findings.some((f) => f.id === 'auto_publish'), note: '' },
    { name: 'Publish safety intact', ok: !findings.some((f) => f.id === 'safety_removed'), note: '' },
    { name: 'Publish/moderation flow untouched', ok: !files.some((f) => PUBLISH_SAFETY_RE.test(f) && /moderation-actions|telegram-sender/.test(f)), note: '' },
    { name: 'Tests present (if code changed)', ok: codeFiles.length === 0 || pr.hasTests, note: '' },
    { name: 'README updated (if code changed)', ok: codeFiles.length === 0 || pr.readmeUpdated, note: '' },
    { name: 'Diff size reasonable', ok: diffSize <= 800, note: `${diffSize} lines` },
    { name: 'Branch fresh', ok: pr.behindBy <= 20 && pr.ageDays <= 30, note: `behind ${pr.behindBy}, age ${pr.ageDays}d` },
    { name: 'No merge conflicts', ok: !pr.mergeConflicts, note: '' },
  ];

  return {
    branch: pr.branch,
    baseBranch: pr.baseBranch,
    verdict,
    riskScore,
    reasons: [...blockedReasons, ...reviewReasons].length ? [...blockedReasons, ...reviewReasons] : ['No policy concerns detected.'],
    requiredHumanActions,
    blockedReasons,
    checklist,
    generatedAt: now.toISOString(),
  };
}

// ── Best-effort local git snapshot (for CLI / bot) ───────────────────────────

function git(args: string): string {
  return execSync(`git ${args}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/**
 * Build a PrSnapshot from local git for `branch` vs `base`. CI status cannot be
 * known locally → 'unknown' unless provided. Best-effort: returns a safe-ish
 * snapshot even if some git calls fail.
 */
export function buildSnapshotFromGit(
  branch: string,
  base = 'main',
  ciStatus: PrSnapshot['ciStatus'] = 'unknown',
): PrSnapshot {
  let changedFiles: string[] = [];
  let additions = 0;
  let deletions = 0;
  let behindBy = 0;
  let ageDays = 0;
  let mergeConflicts = false;

  try {
    const mb = git(`merge-base ${base} ${branch}`);
    changedFiles = git(`diff --name-only ${mb} ${branch}`).split('\n').filter(Boolean);
    const numstat = git(`diff --numstat ${mb} ${branch}`).split('\n').filter(Boolean);
    for (const line of numstat) {
      const [a, d] = line.split('\t');
      additions += Number(a) || 0;
      deletions += Number(d) || 0;
    }
    behindBy = Number(git(`rev-list --count ${branch}..${base}`)) || 0;
    const lastCommitTs = Number(git(`log -1 --format=%ct ${branch}`)) * 1000;
    if (lastCommitTs) ageDays = Math.round((Date.now() - lastCommitTs) / 86_400_000);
    const mt = git(`merge-tree ${base} ${branch}`);
    mergeConflicts = /<<<<<<<|changed in both|CONFLICT/.test(mt);
  } catch {
    /* best-effort */
  }

  const hasTests = changedFiles.some((f) => isTest(f));
  const readmeUpdated = changedFiles.some((f) => isDoc(f));
  let diffText = '';
  try {
    const mb = git(`merge-base ${base} ${branch}`);
    diffText = git(`diff ${mb} ${branch}`);
  } catch {
    /* ignore */
  }

  return {
    branch, baseBranch: base, ciStatus, changedFiles, additions, deletions,
    hasTests, readmeUpdated, behindBy, mergeConflicts, ageDays, diffText,
  };
}
