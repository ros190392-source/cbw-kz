import { describe, it, expect } from 'vitest';
import {
  buildGeoManual,
  claimIdFor,
  findStep,
  generateTesterTasks,
  screenshotIssues,
  GUIDE_SAFETY_RULES,
} from '../services/manual-builder';
import { ExchangeRecord, ScreenshotRecord } from '../src/types';

const NOW = new Date('2026-06-10T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function exch(over: Partial<ExchangeRecord> = {}): ExchangeRecord {
  return {
    name: 'Bybit', slug: 'bybit', officialUrl: 'x', affiliateUrl: 'x', supportedGeos: ['*'], restrictedGeos: ['US'],
    kyc: 'basic', p2p: true, fiat: ['KZT'],
    kazakhstan: { available: true, p2p: true, kyc: 'basic', fiat: ['KZT'], notes: '' },
    trustLevel: 'high', notes: '', lastReviewedAt: null, ...over,
  };
}

function shot(over: Partial<ScreenshotRecord> = {}): ScreenshotRecord {
  return {
    id: over.id ?? 's1', exchange: over.exchange ?? 'bybit', geo: over.geo ?? 'KZ', locale: 'ru-KZ',
    claimId: over.claimId ?? 'bybit:KZ:p2p:select-fiat',
    screenshotType: over.screenshotType ?? 'interface_only',
    filePath: '/x.png', capturedAt: over.capturedAt ?? NOW.toISOString(), reviewer: 'alice',
    containsSensitiveData: over.containsSensitiveData ?? false,
    redactionStatus: over.redactionStatus ?? 'not_required',
    evidenceLevel: over.evidenceLevel ?? 'B', notes: '',
  };
}

describe('manual generation', () => {
  it('builds a GEO manual with steps, coverage, weakest step and readiness', () => {
    const m = buildGeoManual(exch(), 'p2p', 'KZ', { now: NOW });
    expect(m.id).toBe('bybit-p2p-KZ');
    expect(m.locale).toBe('ru-KZ');
    expect(m.steps.length).toBeGreaterThan(3);
    // p2p has E baseline steps → not ready, needs a local tester.
    expect(m.readiness).toBe('not_ready');
    expect(m.requiresLocalTester).toBe(true);
    expect(m.fullyVerified).toBe(false);
    expect(m.weakestStep?.level).toBe('E');
  });

  it('does not fabricate verification — never fully verified without real evidence', () => {
    const m = buildGeoManual(exch(), 'kyc', 'KZ', { now: NOW });
    expect(m.fullyVerified).toBe(false);
    expect(m.warnings.some((w) => /unverified steps \(E\)/i.test(w))).toBe(true);
  });
});

describe('evidence-aware phrasing', () => {
  it('maps evidence levels to honest verification statuses', () => {
    const m = buildGeoManual(exch(), 'p2p', 'KZ', { now: NOW });
    const reviewStep = findStep(m, 'review-offer')!; // C baseline
    const selectFiat = findStep(m, 'select-fiat')!; // E baseline
    expect(reviewStep.verificationStatus).toBe('documented');
    expect(selectFiat.verificationStatus).toBe('unverified');
    expect(selectFiat.requiresLocalTester).toBe(true);
    // E confidence is low; C is higher.
    expect(selectFiat.confidence).toBeLessThan(reviewStep.confidence);
  });
});

describe('screenshot mapping', () => {
  it('a fresh, safe interface screenshot raises a step to verified', () => {
    const screenshots = [shot({ id: 'sf', claimId: claimIdFor('bybit', 'KZ', 'p2p', 'select-fiat'), evidenceLevel: 'B' })];
    const m = buildGeoManual(exch(), 'p2p', 'KZ', { now: NOW, screenshots });
    const s = findStep(m, 'select-fiat')!;
    expect(s.evidenceLevel).toBe('B');
    expect(s.verificationStatus).toBe('verified');
    expect(s.screenshotStatus).toBe('present');
    expect(s.screenshotIds).toContain('sf');
  });
});

describe('missing screenshot detection', () => {
  it('flags steps that expect a screenshot but have none', () => {
    const m = buildGeoManual(exch(), 'deposit', 'KZ', { now: NOW });
    const issues = screenshotIssues(m);
    expect(issues.some((i) => i.status === 'missing')).toBe(true);
    const selectMethod = findStep(m, 'select-method')!;
    expect(selectMethod.screenshotStatus).toBe('missing');
    expect(selectMethod.warning).toMatch(/no screenshot/i);
  });
});

describe('unsafe screenshot detection', () => {
  it('detects unsafe (unredacted) screenshots and never raises evidence on them', () => {
    const screenshots = [shot({
      id: 'unsafe', claimId: claimIdFor('bybit', 'KZ', 'deposit', 'confirm-deposit'),
      screenshotType: 'live_test', evidenceLevel: 'A', containsSensitiveData: true, redactionStatus: 'pending',
    })];
    const m = buildGeoManual(exch(), 'deposit', 'KZ', { now: NOW, screenshots });
    const s = findStep(m, 'confirm-deposit')!;
    expect(s.screenshotStatus).toBe('unsafe');
    expect(s.evidenceLevel).toBe('E'); // base — NOT raised to A
    expect(s.warning).toMatch(/redaction/i);
    expect(m.warnings.some((w) => /redaction/i.test(w))).toBe(true);
  });

  it('treats stale screenshots as outdated and does not raise evidence', () => {
    const screenshots = [shot({
      id: 'old', claimId: claimIdFor('bybit', 'KZ', 'p2p', 'select-fiat'), evidenceLevel: 'B', capturedAt: daysAgo(200),
    })];
    const m = buildGeoManual(exch(), 'p2p', 'KZ', { now: NOW, screenshots });
    const s = findStep(m, 'select-fiat')!;
    expect(s.screenshotStatus).toBe('outdated');
    expect(s.evidenceLevel).toBe('E');
    expect(s.warning).toMatch(/outdated/i);
  });
});

describe('local tester tasks', () => {
  it('generates prioritized, safety-aware tasks (E → highest, redaction rules attached)', () => {
    const m = buildGeoManual(exch(), 'p2p', 'KZ', { now: NOW });
    const tasks = generateTesterTasks(m);
    expect(tasks.length).toBeGreaterThan(0);
    for (let i = 1; i < tasks.length; i++) expect(tasks[i - 1].priority).toBeGreaterThanOrEqual(tasks[i].priority);
    expect(tasks[0].priority).toBe(85);
    expect(tasks[0].mustRedact).toEqual(GUIDE_SAFETY_RULES);
    // live-test steps expect level A; interface steps expect B.
    const confirm = tasks.find((t) => t.stepId === 'confirm-payment');
    expect(confirm?.expectedEvidenceLevel).toBe('A');
    const filter = tasks.find((t) => t.stepId === 'filter-payment');
    expect(filter?.expectedEvidenceLevel).toBe('B');
  });
});

describe('GEO differences', () => {
  it('injects local payment methods and currency per GEO', () => {
    const kz = buildGeoManual(exch(), 'deposit', 'KZ', { now: NOW });
    const de = buildGeoManual(exch(), 'deposit', 'DE', { now: NOW });
    expect(findStep(kz, 'select-method')!.description).toMatch(/Kaspi/);
    expect(findStep(kz, 'enter-amount')!.description).toMatch(/KZT/);
    expect(findStep(de, 'select-method')!.description).toMatch(/SEPA/);
    expect(findStep(de, 'enter-amount')!.description).toMatch(/EUR/);
  });

  it('surfaces GEO restrictions as manual warnings (DE MiCA, KZ none)', () => {
    const de = buildGeoManual(exch(), 'kyc', 'DE', { now: NOW });
    const kz = buildGeoManual(exch(), 'kyc', 'KZ', { now: NOW });
    expect(de.warnings.some((w) => /MiCA|EU/i.test(w))).toBe(true);
    // KZ has no special restriction lines (only the evidence warning).
    expect(kz.warnings.every((w) => !/MiCA/i.test(w))).toBe(true);
  });

  it('warns when an exchange is unavailable in a GEO', () => {
    const blocked = exch({ restrictedGeos: ['US', 'KZ'], kazakhstan: { available: false, p2p: false, kyc: 'basic', fiat: [], notes: '' } });
    const m = buildGeoManual(blocked, 'p2p', 'KZ', { now: NOW });
    expect(m.warnings.some((w) => /may not be available/i.test(w))).toBe(true);
  });
});
