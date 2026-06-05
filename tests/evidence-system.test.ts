import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  assessEvidence,
  buildManualTrust,
  evidencePhrasing,
  missingEvidenceQueue,
  seedManuals,
} from '../services/evidence-system';
import { ScreenshotRegistry, needsRedaction } from '../services/screenshot-registry';
import { generateDraft } from '../services/content-engine';
import { ExchangeRecord, ManualStep, ScreenshotRecord } from '../src/types';

const NOW = new Date('2026-06-10T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const tmpDirs: string[] = [];
function registry(): ScreenshotRegistry {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cbw-shots-'));
  tmpDirs.push(d);
  return new ScreenshotRegistry('screenshots.json', d);
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function shot(over: Partial<ScreenshotRecord> = {}): ScreenshotRecord {
  return {
    id: over.id ?? 's1', exchange: over.exchange ?? 'bybit', geo: 'KZ', locale: 'ru-KZ',
    claimId: over.claimId ?? 'bybit:KZ:p2p', screenshotType: over.screenshotType ?? 'interface_only',
    filePath: '/x.png', capturedAt: NOW.toISOString(), reviewer: 'alice',
    containsSensitiveData: over.containsSensitiveData ?? false, redactionStatus: over.redactionStatus ?? 'not_required',
    evidenceLevel: over.evidenceLevel ?? 'B', notes: '',
  };
}
function step(id: string, level: ManualStep['evidenceLevel']): ManualStep {
  return { id, description: `do ${id}`, evidenceLevel: level, screenshotId: null, requiresLocalTester: level === 'E' };
}
function exch(over: Partial<ExchangeRecord> = {}): ExchangeRecord {
  return {
    name: 'Bybit', slug: 'bybit', officialUrl: 'x', affiliateUrl: 'x', supportedGeos: ['*'], restrictedGeos: ['US'],
    kyc: 'basic', p2p: true, fiat: ['KZT'], kazakhstan: { available: true, p2p: true, kyc: 'basic', fiat: ['KZT'], notes: '' },
    trustLevel: 'high', notes: '', lastReviewedAt: null, ...over,
  };
}

describe('evidence level scoring', () => {
  it('ranks A high, E low, and E needs a local tester', () => {
    expect(assessEvidence('A', daysAgo(2), NOW).confidence).toBe(95);
    const e = assessEvidence('E', null, NOW);
    expect(e.confidence).toBe(10);
    expect(e.requiresLocalTester).toBe(true);
    expect(assessEvidence('A', daysAgo(2), NOW).confidence).toBeGreaterThan(assessEvidence('D', daysAgo(2), NOW).confidence);
  });

  it('decays confidence for stale and undated checks', () => {
    expect(assessEvidence('A', daysAgo(200), NOW).confidence).toBeLessThan(95);
    expect(assessEvidence('A', null, NOW).confidence).toBeLessThan(95);
  });

  it('phrasing reflects level', () => {
    expect(evidencePhrasing('A')).toBe('verified');
    expect(evidencePhrasing('B')).toBe('verified');
    expect(evidencePhrasing('C')).toBe('according to official documentation');
    expect(evidencePhrasing('D')).toBe('reported by users');
    expect(evidencePhrasing('E')).toBe('requires local verification');
  });
});

describe('screenshot registry + sensitive data', () => {
  it('persists records and reloads', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbw-shots-'));
    tmpDirs.push(dir);
    const reg = new ScreenshotRegistry('screenshots.json', dir);
    reg.add(shot({ id: 'a' }));
    expect(new ScreenshotRegistry('screenshots.json', dir).get('a')).toBeDefined();
  });

  it('sensitive data forces pending redaction and blocks use until redacted', () => {
    const reg = registry();
    const rec = reg.add(shot({ id: 'sens', containsSensitiveData: true, redactionStatus: 'not_required' }));
    expect(rec.redactionStatus).toBe('pending');
    expect(needsRedaction(rec)).toBe(true);
    expect(reg.redactionBacklog().map((r) => r.id)).toContain('sens');
    const fixed = reg.markRedacted('sens', 'bob')!;
    expect(needsRedaction(fixed)).toBe(false);
  });
});

describe('manual trust readiness', () => {
  it('all A/B → ready (100% coverage)', () => {
    const m = buildManualTrust({ manualId: 'm', geo: 'KZ', exchange: 'bybit', topic: 'P2P', steps: [step('s1', 'A'), step('s2', 'B')] });
    expect(m.evidenceCoverage).toBe(100);
    expect(m.publishReadiness).toBe('ready');
  });
  it('any E → not_ready and flagged as missing', () => {
    const m = buildManualTrust({ manualId: 'm', geo: 'KZ', exchange: 'bybit', topic: 'P2P', steps: [step('s1', 'A'), step('s2', 'E')] });
    expect(m.publishReadiness).toBe('not_ready');
    expect(m.weakestStep).toEqual({ id: 's2', level: 'E' });
    expect(m.missingEvidence).toContain('s2');
  });
  it('a D step (no E) → needs_review', () => {
    const m = buildManualTrust({ manualId: 'm', geo: 'KZ', exchange: 'bybit', topic: 'KYC', steps: [step('s1', 'B'), step('s2', 'D')] });
    expect(m.publishReadiness).toBe('needs_review');
  });
});

describe('missing-evidence queue', () => {
  it('generates prioritized tasks (E → local tester, high priority) with safe-capture instructions', () => {
    const tasks = missingEvidenceQueue(seedManuals());
    expect(tasks.length).toBeGreaterThan(0);
    // sorted desc by priority
    for (let i = 1; i < tasks.length; i++) expect(tasks[i - 1].priority).toBeGreaterThanOrEqual(tasks[i].priority);
    const top = tasks[0];
    expect(top.priority).toBe(85);
    expect(top.requiredReviewer).toBe('local_tester');
    expect(top.safeCaptureInstructions.toLowerCase()).toContain('redact');
  });
});

describe('content engine evidence integration', () => {
  it('low evidence (E) adds a warning and phrases as "requires local verification"', () => {
    const d = generateDraft({ type: 'telegram_post', exchange: exch(), geo: 'KZ', evidenceLevel: 'E', now: NOW });
    expect(d.warnings.some((w) => /not verified/i.test(w))).toBe(true);
    expect(d.confidenceNote).toContain('requires local verification');
  });
  it('strong evidence (A) adds no evidence warning and phrases as "verified"', () => {
    const d = generateDraft({ type: 'telegram_post', exchange: exch(), geo: 'KZ', evidenceLevel: 'A', now: NOW });
    expect(d.warnings.some((w) => /not verified|reported by users/i.test(w))).toBe(false);
    expect(d.confidenceNote).toContain('verified');
  });
});
