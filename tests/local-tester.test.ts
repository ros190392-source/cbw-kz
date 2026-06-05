import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  assignTask,
  assignTasks,
  detectUnsafe,
  effectiveTrustScore,
  newSubmission,
  newTester,
  reviewSubmission,
  trustLevelFor,
  TesterRegistry,
  SubmissionStore,
} from '../services/local-tester';
import { EvidenceSubmission, LocalTesterTask, ScreenshotRecord, TesterProfile } from '../src/types';

const NOW = new Date('2026-06-10T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const tmpDirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cbw-tester-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function task(over: Partial<LocalTesterTask> = {}): LocalTesterTask {
  return {
    id: over.id ?? 'k1', exchange: over.exchange ?? 'bybit', geo: over.geo ?? 'KZ',
    topic: over.topic ?? 'p2p', stepId: over.stepId ?? 'select-fiat', whatToTest: 'test it',
    screenshotsRequired: [], mustRedact: [], expectedEvidenceLevel: over.expectedEvidenceLevel ?? 'B',
    priority: over.priority ?? 85,
  };
}
function sub(over: Partial<EvidenceSubmission> = {}): EvidenceSubmission {
  return newSubmission({ id: over.id ?? 's1', testerId: over.testerId ?? 'almaz_kz', exchange: 'bybit', geo: 'KZ', ...over });
}
function shot(over: Partial<ScreenshotRecord> = {}): ScreenshotRecord {
  return {
    id: over.id ?? 'img1', exchange: 'bybit', geo: 'KZ', locale: 'ru-KZ', claimId: 'c',
    screenshotType: over.screenshotType ?? 'interface_only', filePath: '/x.png', capturedAt: NOW.toISOString(),
    reviewer: 'r', containsSensitiveData: over.containsSensitiveData ?? false,
    redactionStatus: over.redactionStatus ?? 'not_required', evidenceLevel: 'B', notes: '',
  };
}

describe('trust scoring', () => {
  it('maps score to level and applies staleness penalty', () => {
    expect(trustLevelFor(90)).toBe('trusted');
    expect(trustLevelFor(70)).toBe('high');
    expect(trustLevelFor(50)).toBe('medium');
    expect(trustLevelFor(20)).toBe('low');
    const fresh = newTester({ id: 't', nickname: 'T', trustScore: 60, lastActiveAt: daysAgo(5) });
    const stale = newTester({ id: 't', nickname: 'T', trustScore: 60, lastActiveAt: daysAgo(200) });
    expect(effectiveTrustScore(fresh, NOW)).toBe(60);
    expect(effectiveTrustScore(stale, NOW)).toBe(45);
  });
});

describe('GEO matching + specialty routing (assignment)', () => {
  const testers: TesterProfile[] = [
    newTester({ id: 'kz_p2p', nickname: 'KZp2p', geos: ['KZ'], specialties: ['p2p'] }),
    newTester({ id: 'kz_kyc', nickname: 'KZkyc', geos: ['KZ'], specialties: ['kyc'] }),
    newTester({ id: 'tr', nickname: 'TR', geos: ['TR'], specialties: ['p2p'] }),
  ];

  it('routes a KYC task to the KYC specialist in the right GEO', () => {
    const a = assignTask(task({ topic: 'kyc', geo: 'KZ' }), testers, NOW);
    expect(a.unassigned).toBe(false);
    expect(a.testerId).toBe('kz_kyc');
    expect(a.reasons).toContain('specialty match');
  });

  it('leaves a task unassigned when no tester covers the GEO', () => {
    const a = assignTask(task({ geo: 'IN' }), testers, NOW);
    expect(a.unassigned).toBe(true);
    expect(a.testerId).toBeNull();
  });

  it('boosts high-traffic GEO and exchange match in the score', () => {
    const exMatch = newTester({ id: 'x', nickname: 'X', geos: ['KZ'], specialties: ['p2p'], exchanges: ['bybit'] });
    const a = assignTask(task({ topic: 'p2p', geo: 'KZ', exchange: 'bybit' }), [exMatch], NOW);
    expect(a.reasons).toContain('high-traffic GEO');
    expect(a.reasons.some((r) => r.includes('exchange'))).toBe(true);
    const assignments = assignTasks([task({ geo: 'IN' }), task({ geo: 'KZ' })], [exMatch], NOW);
    expect(assignments[0].unassigned).toBe(false); // assigned tasks sorted ahead of unassigned
  });
});

describe('safety / unsafe evidence', () => {
  it('flags submissions with sensitive flags, forbidden text or unredacted screenshots', () => {
    expect(detectUnsafe(sub({ sensitiveDataDetected: true })).unsafe).toBe(true);
    expect(detectUnsafe(sub({ notes: 'contact me at john@example.com' })).unsafe).toBe(true);
    const screenshots = [shot({ id: 'bad', containsSensitiveData: true, redactionStatus: 'pending' })];
    expect(detectUnsafe(sub({ screenshotIds: ['bad'] }), screenshots).unsafe).toBe(true);
    expect(detectUnsafe(sub({ notes: 'clean interface only' })).unsafe).toBe(false);
  });
});

describe('review flow', () => {
  it('requires a reviewerId', () => {
    expect(() => reviewSubmission(sub(), 'approve', '', 'note')).toThrow(/reviewerId/);
  });

  it('approves safe evidence, raises trust, records final level', () => {
    const out = reviewSubmission(sub({ evidenceLevelSuggested: 'B' }), 'approve', 'editor1', 'looks good', [], NOW);
    expect(out.submission.status).toBe('approved');
    expect(out.submission.finalEvidenceLevel).toBe('B');
    expect(out.trustDelta).toBeGreaterThan(0);
    expect(out.blocked).toBe(false);
  });

  it('BLOCKS approval of unsafe evidence → needs_redaction, trust penalty', () => {
    const out = reviewSubmission(sub({ sensitiveDataDetected: true, evidenceLevelSuggested: 'A' }), 'approve', 'editor1', 'approve', [], NOW);
    expect(out.blocked).toBe(true);
    expect(out.submission.status).toBe('needs_redaction');
    expect(out.submission.finalEvidenceLevel).toBeNull();
    expect(out.trustDelta).toBeLessThan(0);
    expect(out.counters.unsafe).toBe(1);
  });

  it('reject lowers trust; downgrade_evidence approves at a lower level', () => {
    expect(reviewSubmission(sub(), 'reject', 'r', 'no', [], NOW).trustDelta).toBeLessThan(0);
    const dg = reviewSubmission(sub({ evidenceLevelSuggested: 'A' }), 'downgrade_evidence', 'r', 'too strong', [], NOW);
    expect(dg.submission.status).toBe('approved');
    expect(dg.submission.finalEvidenceLevel).toBe('B'); // A → B
  });
});

describe('stores + end-to-end submission workflow', () => {
  it('persists testers and submissions; review updates both', () => {
    const dir = tmp();
    const reg = new TesterRegistry('testers.json', dir);
    const subs = new SubmissionStore('submissions.json', dir);
    reg.add(newTester({ id: 'almaz_kz', nickname: 'Almaz', geos: ['KZ'], specialties: ['p2p'], trustScore: 50 }));
    subs.add(sub({ id: 'sub1', testerId: 'almaz_kz', evidenceLevelSuggested: 'B' }));
    expect(subs.pending().length).toBe(1);

    const out = subs.review(reg, 'sub1', 'approve', 'editor1', 'ok', [], NOW);
    expect(out.submission.status).toBe('approved');
    const t = reg.get('almaz_kz')!;
    expect(t.approvedSubmissions).toBe(1);
    expect(t.trustScore).toBe(56);
    expect(t.lastActiveAt).toBe(NOW.toISOString());

    // reload from disk
    expect(new SubmissionStore('submissions.json', dir).get('sub1')!.status).toBe('approved');
    expect(new TesterRegistry('testers.json', dir).get('almaz_kz')!.approvedSubmissions).toBe(1);
  });

  it('seed is idempotent and creates KZ/TR testers', () => {
    const dir = tmp();
    const reg = new TesterRegistry('testers.json', dir);
    reg.seed();
    const n = reg.all().length;
    expect(n).toBeGreaterThan(0);
    reg.seed();
    expect(reg.all().length).toBe(n);
    expect(reg.all().some((t) => t.geos.includes('KZ'))).toBe(true);
  });
});
