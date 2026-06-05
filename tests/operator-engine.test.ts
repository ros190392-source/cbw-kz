import { describe, it, expect } from 'vitest';
import {
  buildHealth,
  buildNextActions,
  buildOperatorReport,
  draftOpportunities,
  OperatorInputs,
} from '../services/operator-engine';
import { emptyMetrics } from '../services/analytics-layer';
import {
  BonusRecord,
  EditorialTopic,
  Evidence,
  ExchangeRecord,
  PostAnalyticsRecord,
  QueueItem,
  VerificationClaim,
} from '../src/types';

const NOW = new Date('2026-06-10T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function exch(over: Partial<ExchangeRecord> = {}): ExchangeRecord {
  return {
    name: 'Bybit', slug: 'bybit', officialUrl: 'x', affiliateUrl: 'x', supportedGeos: ['*'], restrictedGeos: ['US'],
    kyc: 'basic', p2p: true, fiat: ['USD'], kazakhstan: { available: true, p2p: true, kyc: 'basic', fiat: ['KZT'], notes: '' },
    trustLevel: 'high', notes: '', lastReviewedAt: null, ...over,
  };
}
function ev(over: Partial<Evidence> = {}): Evidence {
  return { id: 'e', sourceUrl: 'https://o', type: over.type ?? 'official_docs', note: '', verifiedAt: over.verifiedAt ?? daysAgo(2), expiresAt: null, status: 'verified', reviewer: 'a' };
}
function claim(over: Partial<VerificationClaim> = {}): VerificationClaim {
  return { id: over.id ?? 'bybit:KZ:p2p', exchangeSlug: 'bybit', country: 'KZ', type: over.type ?? 'p2p', assertion: 'true', evidence: over.evidence ?? [], conflicting: false, staleAfterDays: 30, lastCheckedAt: 'lastCheckedAt' in over ? over.lastCheckedAt! : null };
}
function bonus(over: Partial<BonusRecord> = {}): BonusRecord {
  return { id: over.id ?? 'b', exchangeSlug: 'bybit', type: 'bonus', title: 'B', description: '', value: null, geos: ['*'], startDate: null, expiryDate: null, sourceUrl: 'x', verification: over.verification ?? { status: 'unverified', source: '', lastCheckedAt: null } };
}
function topic(over: Partial<EditorialTopic> = {}): EditorialTopic {
  return { id: over.id ?? 't1', title: over.title ?? 'Bybit Launchpool', type: 'launchpool', exchange: over.exchange ?? 'bybit', geo: 'KZ', locale: 'ru-KZ', priority: over.priority ?? 80, priorityBand: 'high', reason: 'r', confidence: 70, suggestedCta: '{{CTA}}', requiredVerification: 'verified' };
}
function qitem(over: Partial<QueueItem> = {}): QueueItem {
  return {
    id: over.id ?? 'q1', title: over.title ?? 'Item', source: over.source ?? 'planner', reason: 'r',
    priority: over.priority ?? 50, status: over.status ?? 'idea',
    requiredVerification: over.requiredVerification ?? null, verificationCleared: over.verificationCleared ?? false,
    geo: 'KZ', locale: 'ru-KZ', exchange: 'bybit', notes: null,
    createdAt: daysAgo(1), updatedAt: daysAgo(1), decidedBy: null, history: [],
  };
}
function post(): PostAnalyticsRecord {
  return { id: 'p', telegramMessageId: 1, channelId: '@c', title: 'T', link: '', source: 'S', category: 'Bonus', priority: 'HIGH', scoreTotal: 70, exchangeMentions: ['bybit'], geoTags: ['KZ'], publishedAt: daysAgo(1), updatedAt: daysAgo(1), metrics: { ...emptyMetrics(), reactions: 10, available: true } };
}

const staleInputs = (over: Partial<OperatorInputs> = {}): OperatorInputs => ({
  posts: over.posts ?? [],
  claims: over.claims ?? [claim()], // baseline stale, conf 0
  bonuses: over.bonuses ?? [bonus()],
  exchanges: [exch()],
  queue: over.queue ?? [],
  plannerTopics: over.plannerTopics ?? [topic()],
  optimization: over.optimization ?? [],
  now: NOW,
});

describe('daily cycle generation', () => {
  it('produces a full command center with the human-gate notes', () => {
    const r = buildOperatorReport(staleInputs());
    expect(r.generatedAt).toBeTruthy();
    expect(r.health).toBeDefined();
    expect(r.nextActions.length).toBeGreaterThan(0);
    expect(r.notes.some((n) => /no auto-publishing/i.test(n))).toBe(true);
    expect(r.notes.some((n) => /final operator/i.test(n))).toBe(true);
  });
});

describe('blocked item detection', () => {
  it('detects verification-blocked queue items and recommends clearing them', () => {
    const blocked = qitem({ id: 'b1', title: 'Gated', status: 'idea', requiredVerification: 'bybit:KZ', verificationCleared: false });
    const r = buildOperatorReport(staleInputs({ queue: [blocked] }));
    expect(r.blockedItems.map((i) => i.id)).toContain('b1');
    expect(r.nextActions.some((a) => a.id === 'act:unblock' && a.kind === 'review_queue')).toBe(true);
  });

  it('a cleared gate is not blocked', () => {
    const cleared = qitem({ id: 'c1', requiredVerification: 'bybit:KZ', verificationCleared: true });
    const r = buildOperatorReport(staleInputs({ queue: [cleared] }));
    expect(r.blockedItems).toHaveLength(0);
  });
});

describe('next action ranking', () => {
  it('sorts actions by priority and surfaces review-ready above tuning', () => {
    const reviewReady = qitem({ id: 'r1', status: 'in_review' });
    const opt = [{ id: 's', type: 'scoring_weight' as const, target: 'category:Bonus', direction: 'increase' as const, observation: 'o', recommendation: 'r', rationale: 'x', confidence: 'high' as const, sampleSize: 10, humanReviewRequired: true }];
    const actions = buildNextActions(staleInputs({ queue: [reviewReady], optimization: opt }), NOW);
    for (let i = 1; i < actions.length; i++) expect(actions[i - 1].priority).toBeGreaterThanOrEqual(actions[i].priority);
    const reviewIdx = actions.findIndex((a) => a.id === 'act:review-ready');
    const tuneIdx = actions.findIndex((a) => a.id === 'act:tune');
    expect(reviewIdx).toBeGreaterThanOrEqual(0);
    expect(tuneIdx).toBeGreaterThan(reviewIdx);
  });

  it('falls back to a maintain action when nothing is pressing', () => {
    // Healthy: verified fresh claim, verified bonus, no queue, no opportunities.
    const healthy = staleInputs({
      claims: [claim({ lastCheckedAt: daysAgo(2), evidence: [ev({ type: 'official_docs' }), ev({ id: 'm', type: 'manual_review' })] })],
      bonuses: [bonus({ verification: { status: 'verified', source: 's', lastCheckedAt: daysAgo(2) } })],
      plannerTopics: [], queue: [], posts: [post()],
    });
    const actions = buildNextActions(healthy, NOW);
    expect(actions.some((a) => a.kind === 'maintain')).toBe(true);
  });
});

describe('stale verification integration', () => {
  it('lists stale claims and raises a verify action', () => {
    const r = buildOperatorReport(staleInputs());
    expect(r.staleVerifications).toContain('bybit:KZ:p2p');
    expect(r.health.staleClaims).toBeGreaterThan(0);
    expect(r.nextActions.some((a) => a.kind === 'verify')).toBe(true);
  });
});

describe('system health', () => {
  it('is red/amber when data is stale, green when everything is fresh & verified', () => {
    expect(buildHealth(staleInputs(), NOW).status).not.toBe('green');
    const healthy = staleInputs({
      claims: [claim({ lastCheckedAt: daysAgo(2), evidence: [ev({ type: 'official_docs' }), ev({ id: 'm', type: 'manual_review' })] })],
      bonuses: [bonus({ verification: { status: 'verified', source: 's', lastCheckedAt: daysAgo(2) } })],
      queue: [], posts: [post()],
    });
    expect(buildHealth(healthy, NOW).status).toBe('green');
  });
});

describe('draft opportunities + no autonomous action guarantee', () => {
  it('ranks opportunities and excludes already-drafted titles', () => {
    const topics = [topic({ id: 'a', title: 'Alpha', priority: 90 }), topic({ id: 'b', title: 'Beta', priority: 40 })];
    const queue = [qitem({ id: 'q', title: 'Alpha', status: 'drafted' })];
    const opps = draftOpportunities(topics, queue);
    expect(opps[0].title).toBe('Beta'); // Alpha excluded (already drafted)
  });

  it('every action is human-required and the report never mutates the queue', () => {
    const queue = [qitem({ id: 'x', status: 'in_review' }), qitem({ id: 'y', status: 'idea' })];
    const before = queue.map((i) => i.status).join(',');
    const r = buildOperatorReport(staleInputs({ queue }));
    expect(r.nextActions.every((a) => a.humanRequired)).toBe(true);
    expect(queue.map((i) => i.status).join(',')).toBe(before); // unchanged
  });
});
