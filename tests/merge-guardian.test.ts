import { describe, it, expect } from 'vitest';
import { evaluatePr } from '../services/merge-guardian';
import { PrSnapshot } from '../src/types';

function snap(over: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    branch: over.branch ?? 'feat/x',
    baseBranch: over.baseBranch ?? 'main',
    ciStatus: over.ciStatus ?? 'passing',
    changedFiles: over.changedFiles ?? [],
    additions: over.additions ?? 20,
    deletions: over.deletions ?? 0,
    hasTests: over.hasTests ?? true,
    readmeUpdated: over.readmeUpdated ?? true,
    behindBy: over.behindBy ?? 0,
    mergeConflicts: over.mergeConflicts ?? false,
    ageDays: over.ageDays ?? 1,
    diffText: over.diffText,
  };
}

describe('SAFE_TO_AUTO_MERGE', () => {
  it('docs-only PR is safe', () => {
    const r = evaluatePr(snap({ changedFiles: ['README.md', 'docs/guide.md'] }));
    expect(r.verdict).toBe('SAFE_TO_AUTO_MERGE');
    expect(r.riskScore).toBeLessThanOrEqual(15);
  });

  it('tests-only PR is safe', () => {
    expect(evaluatePr(snap({ changedFiles: ['tests/foo.test.ts'] })).verdict).toBe('SAFE_TO_AUTO_MERGE');
  });

  it('isolated new service + tests + README is safe', () => {
    const r = evaluatePr(snap({ changedFiles: ['services/foo-engine/index.ts', 'tests/foo.test.ts', 'README.md'] }));
    expect(r.verdict).toBe('SAFE_TO_AUTO_MERGE');
  });
});

describe('BLOCKED', () => {
  it('committed .env is blocked (but .env.example is not)', () => {
    expect(evaluatePr(snap({ changedFiles: ['.env'] })).verdict).toBe('BLOCKED');
    const ex = evaluatePr(snap({ changedFiles: ['.env.example'], hasTests: false, readmeUpdated: false }));
    expect(ex.blockedReasons.some((b) => /Environment file/.test(b))).toBe(false);
  });

  it('secrets in the diff are blocked', () => {
    const diff = '+const t = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab";';
    const r = evaluatePr(snap({ changedFiles: ['src/x.ts'], diffText: diff }));
    expect(r.verdict).toBe('BLOCKED');
    expect(r.blockedReasons.some((b) => /token/i.test(b))).toBe(true);
  });

  it('auto-publish code is blocked', () => {
    const r = evaluatePr(snap({ changedFiles: ['apps/telegram-bot/index.ts'], diffText: '+  autoPublish(draft);' }));
    expect(r.verdict).toBe('BLOCKED');
    expect(r.blockedReasons.some((b) => /auto-publish/i.test(b))).toBe(true);
  });

  it('removing a publish-safety marker is blocked', () => {
    const diff = '- humanReviewRequired: true,';
    const r = evaluatePr(snap({ changedFiles: ['src/moderation-actions.ts'], diffText: diff }));
    expect(r.verdict).toBe('BLOCKED');
    expect(r.blockedReasons.some((b) => /safety marker removed/i.test(b))).toBe(true);
  });

  it('failing CI is blocked', () => {
    expect(evaluatePr(snap({ changedFiles: ['README.md'], ciStatus: 'failing' })).verdict).toBe('BLOCKED');
  });

  it('merge conflicts are blocked', () => {
    expect(evaluatePr(snap({ changedFiles: ['README.md'], mergeConflicts: true })).verdict).toBe('BLOCKED');
  });

  it('blocked PRs carry a high risk score', () => {
    expect(evaluatePr(snap({ changedFiles: ['.env'] })).riskScore).toBeGreaterThanOrEqual(85);
  });
});

describe('REQUIRES_HUMAN_REVIEW', () => {
  it('publish-flow change requires review', () => {
    const r = evaluatePr(snap({ changedFiles: ['src/moderation-actions.ts'] }));
    expect(r.verdict).toBe('REQUIRES_HUMAN_REVIEW');
    expect(r.reasons.some((x) => /moderation\/publish flow/.test(x))).toBe(true);
  });

  it('scoring change requires review', () => {
    expect(evaluatePr(snap({ changedFiles: ['services/scoring-layer/index.ts'] })).verdict).toBe('REQUIRES_HUMAN_REVIEW');
  });

  it('bot command change requires review', () => {
    expect(evaluatePr(snap({ changedFiles: ['apps/telegram-bot/index.ts'] })).verdict).toBe('REQUIRES_HUMAN_REVIEW');
  });

  it('stale branch requires review', () => {
    const r = evaluatePr(snap({ changedFiles: ['README.md'], behindBy: 30 }));
    expect(r.verdict).toBe('REQUIRES_HUMAN_REVIEW');
    expect(r.reasons.some((x) => /behind/.test(x))).toBe(true);
  });

  it('code without tests requires review', () => {
    const r = evaluatePr(snap({ changedFiles: ['services/foo/index.ts'], hasTests: false }));
    expect(r.verdict).toBe('REQUIRES_HUMAN_REVIEW');
    expect(r.reasons.some((x) => /without accompanying tests/.test(x))).toBe(true);
  });

  it('unknown CI never auto-merges', () => {
    expect(evaluatePr(snap({ changedFiles: ['README.md'], ciStatus: 'unknown' })).verdict).toBe('REQUIRES_HUMAN_REVIEW');
  });
});

describe('checklist + reporting', () => {
  it('always returns a checklist and a verdict', () => {
    const r = evaluatePr(snap({ changedFiles: ['README.md'] }));
    expect(r.checklist.length).toBeGreaterThan(5);
    expect(['SAFE_TO_AUTO_MERGE', 'REQUIRES_HUMAN_REVIEW', 'BLOCKED']).toContain(r.verdict);
    expect(r.checklist.find((c) => c.name === 'CI passing')!.ok).toBe(true);
  });
});
