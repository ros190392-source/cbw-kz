import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  VerificationStore,
  buildKzSnapshot,
  claimFreshness,
  computeConfidence,
  confidenceBand,
  evidenceFreshness,
  freshnessFromAge,
  isReliable,
  staleClaims,
  validateEvidence,
  verdictFor,
  verificationAnalytics,
} from '../services/verification-engine';
import { DEFAULT_BONUSES, DEFAULT_EXCHANGES } from '../services/exchange-registry';
import { Evidence, ExchangeRecord, VerificationClaim } from '../src/types';

const NOW = new Date('2026-06-10T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function ev(over: Partial<Evidence> = {}): Evidence {
  return {
    id: over.id ?? 'e1',
    sourceUrl: over.sourceUrl ?? 'https://official.example/docs',
    type: over.type ?? 'official_docs',
    note: over.note ?? '',
    verifiedAt: over.verifiedAt ?? daysAgo(2),
    expiresAt: over.expiresAt ?? null,
    status: over.status ?? 'verified',
    reviewer: over.reviewer ?? 'alice',
  };
}

function claim(over: Partial<VerificationClaim> = {}): VerificationClaim {
  return {
    id: over.id ?? 'bybit:KZ:p2p',
    exchangeSlug: over.exchangeSlug ?? 'bybit',
    country: over.country ?? 'KZ',
    type: over.type ?? 'p2p',
    assertion: over.assertion ?? 'true',
    evidence: over.evidence ?? [ev()],
    conflicting: over.conflicting ?? false,
    staleAfterDays: over.staleAfterDays ?? 30,
    // Respect an explicit null (never-checked); only default when omitted.
    lastCheckedAt: 'lastCheckedAt' in over ? over.lastCheckedAt! : daysAgo(2),
  };
}

function ex(over: Partial<ExchangeRecord> = {}): ExchangeRecord {
  return {
    name: 'Bybit', slug: 'bybit', officialUrl: 'https://x', affiliateUrl: 'https://x',
    supportedGeos: ['*'], restrictedGeos: ['US'], kyc: 'basic', p2p: true, fiat: ['USD'],
    kazakhstan: { available: true, p2p: true, kyc: 'basic', fiat: ['KZT', 'Kaspi', 'Halyk'], notes: 'note' },
    trustLevel: 'high', notes: '', lastReviewedAt: null,
    ...over,
  };
}

const tmpDirs: string[] = [];
function freshDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbw-verify-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('freshness engine', () => {
  it('bands by age relative to TTL', () => {
    expect(freshnessFromAge(daysAgo(5), 30, NOW)).toBe('fresh');   // ≤15
    expect(freshnessFromAge(daysAgo(20), 30, NOW)).toBe('aging');  // ≤30
    expect(freshnessFromAge(daysAgo(45), 30, NOW)).toBe('stale');  // ≤60
    expect(freshnessFromAge(daysAgo(90), 30, NOW)).toBe('expired');
  });
  it('never-checked → expired', () => {
    expect(freshnessFromAge(null, 30, NOW)).toBe('expired');
  });
  it('evidence respects a hard expiry', () => {
    expect(evidenceFreshness(ev({ verifiedAt: daysAgo(1), expiresAt: daysAgo(1) }), 30, NOW)).toBe('expired');
  });
});

describe('confidence scoring', () => {
  it('no evidence → 0', () => {
    expect(computeConfidence(claim({ evidence: [] }), NOW)).toBe(0);
  });

  it('official docs + recent manual review → high (≥85)', () => {
    const c = claim({
      evidence: [
        ev({ id: 'a', type: 'official_docs', status: 'verified', verifiedAt: daysAgo(2) }),
        ev({ id: 'b', type: 'manual_review', status: 'verified', verifiedAt: daysAgo(2), sourceUrl: '' }),
      ],
    });
    const conf = computeConfidence(c, NOW);
    expect(conf).toBeGreaterThanOrEqual(85);
    expect(confidenceBand(conf)).toBe('high');
  });

  it('a single fresh user report → low band (~40)', () => {
    const c = claim({ evidence: [ev({ type: 'user_report', status: 'verified', sourceUrl: '' })] });
    const conf = computeConfidence(c, NOW);
    expect(conf).toBe(40);
    expect(confidenceBand(conf)).toBe('low');
  });

  it('an old, unverified user report → very low (prefers uncertainty)', () => {
    const c = claim({ evidence: [ev({ type: 'user_report', status: 'unverified', verifiedAt: daysAgo(200), sourceUrl: '' })] });
    expect(computeConfidence(c, NOW)).toBeLessThan(25);
  });

  it('conflicting evidence applies a penalty', () => {
    const base = claim();
    const conflicted = claim({ conflicting: true });
    expect(computeConfidence(conflicted, NOW)).toBe(computeConfidence(base, NOW) - 25);
  });
});

describe('evidence validation', () => {
  it('accepts well-formed evidence', () => {
    expect(validateEvidence(ev()).ok).toBe(true);
  });
  it('official evidence requires a sourceUrl', () => {
    const r = validateEvidence(ev({ type: 'official_docs', sourceUrl: '' }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('sourceUrl');
  });
  it('manual_review without sourceUrl is allowed', () => {
    expect(validateEvidence(ev({ type: 'manual_review', sourceUrl: '' })).ok).toBe(true);
  });
  it('rejects missing reviewer and bad expiry order', () => {
    expect(validateEvidence(ev({ reviewer: '' })).ok).toBe(false);
    expect(validateEvidence(ev({ verifiedAt: daysAgo(1), expiresAt: daysAgo(5) })).ok).toBe(false);
  });
});

describe('verdict + reliability', () => {
  it('reliable requires confidence ≥60 AND fresh/aging', () => {
    expect(isReliable(90, 'fresh')).toBe(true);
    expect(isReliable(90, 'stale')).toBe(false);
    expect(isReliable(50, 'fresh')).toBe(false);
  });
  it('verdictFor reports confidence, freshness and evidence count', () => {
    const v = verdictFor(claim(), NOW);
    expect(v.evidenceCount).toBe(1);
    expect(v.reliable).toBe(true);
    expect(v.confidence).toBeGreaterThan(0);
  });
});

describe('stale detection', () => {
  it('flags never-checked and old claims, not fresh ones', () => {
    const fresh = claim({ id: 'fresh', lastCheckedAt: daysAgo(2) });
    const never = claim({ id: 'never', lastCheckedAt: null });
    const old = claim({ id: 'old', lastCheckedAt: daysAgo(120) });
    const stale = staleClaims([fresh, never, old], NOW).map((c) => c.id);
    expect(stale).toContain('never');
    expect(stale).toContain('old');
    expect(stale).not.toContain('fresh');
  });
});

describe('GEO snapshot generation', () => {
  it('no claims → confidence 0, not reliable, notes flagged', () => {
    const snap = buildKzSnapshot(ex(), [], NOW);
    expect(snap.confidence).toBe(0);
    expect(snap.reliable).toBe(false);
    expect(snap.notes.toLowerCase()).toContain('low confidence');
    expect(snap.freshness).toBe('expired');
  });

  it('strong fresh claims → reliable, values pulled from the registry', () => {
    const claims = [
      claim({ id: 'bybit:KZ:p2p', type: 'p2p', evidence: [ev({ type: 'official_docs' }), ev({ id: 'm', type: 'manual_review', sourceUrl: '' })] }),
    ];
    const snap = buildKzSnapshot(ex(), claims, NOW);
    expect(snap.reliable).toBe(true);
    expect(snap.kyc).toBe('basic');
    expect(snap.p2p).toBe(true);
    expect(snap.kzt).toBe(true);
    expect(snap.localBanks).toEqual(['Kaspi', 'Halyk']);
  });
});

describe('verification analytics (Phase 7)', () => {
  it('summarizes bands, stale claims and outdated bonuses', () => {
    const strong = claim({ id: 's', lastCheckedAt: daysAgo(2), evidence: [ev({ type: 'official_docs' }), ev({ id: 'm', type: 'manual_review', sourceUrl: '' })] });
    const weak = claim({ id: 'w', lastCheckedAt: null, evidence: [ev({ type: 'user_report', status: 'unverified', verifiedAt: daysAgo(200), sourceUrl: '' })] });
    const a = verificationAnalytics([strong, weak], DEFAULT_BONUSES, NOW);
    expect(a.totalClaims).toBe(2);
    expect(a.byBand.high).toBeGreaterThanOrEqual(1);
    expect(a.byBand.very_low).toBeGreaterThanOrEqual(1);
    expect(a.staleClaims).toContain('w');
    expect(a.recentlyChecked).toBe(1);
    expect(a.outdatedBonuses.length).toBe(DEFAULT_BONUSES.length); // all seeds unverified
  });
});

describe('VerificationStore persistence', () => {
  it('seeds low-confidence baselines and persists; reload reads them', () => {
    const dir = freshDir();
    const store = new VerificationStore(DEFAULT_EXCHANGES, 'verifications.json', dir);
    expect(store.all().length).toBe(DEFAULT_EXCHANGES.length * 4); // 4 claim types each
    // baselines are very low confidence (never verified)
    const sample = store.get('bybit:KZ:p2p')!;
    expect(computeConfidence(sample, NOW)).toBeLessThan(25);
    expect(claimFreshness(sample, NOW)).toBe('expired');

    const reloaded = new VerificationStore(DEFAULT_EXCHANGES, 'verifications.json', dir);
    expect(reloaded.all().length).toBe(DEFAULT_EXCHANGES.length * 4);
  });

  it('addEvidence raises confidence and refreshes; rejects invalid evidence', () => {
    const dir = freshDir();
    const store = new VerificationStore(DEFAULT_EXCHANGES, 'verifications.json', dir);
    const id = 'bybit:KZ:p2p';
    const before = computeConfidence(store.get(id)!, NOW);
    store.addEvidence(id, ev({ id: 'official', type: 'official_docs', status: 'verified' }), NOW);
    const after = computeConfidence(store.get(id)!, NOW);
    expect(after).toBeGreaterThan(before);
    expect(claimFreshness(store.get(id)!, NOW)).toBe('fresh');

    // invalid: official with no source → rejected, claim unchanged
    const evCount = store.get(id)!.evidence.length;
    expect(store.addEvidence(id, ev({ id: 'bad', type: 'official_docs', sourceUrl: '' }), NOW)).toBeUndefined();
    expect(store.get(id)!.evidence.length).toBe(evCount);
  });
});
