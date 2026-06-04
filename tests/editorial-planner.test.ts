import { describe, it, expect } from 'vitest';
import {
  DAILY_MIX,
  WEEKLY_MIX,
  band,
  bucketOf,
  bonusTopics,
  buildPlan,
  backlog,
  categoryTopics,
  localeGapTopics,
  verificationUpdateTopics,
  PlannerInputs,
} from '../services/editorial-planner';
import { emptyMetrics } from '../services/analytics-layer';
import {
  BonusRecord,
  ExchangeRecord,
  PostAnalyticsRecord,
  VerificationClaim,
} from '../src/types';

const NOW = new Date('2026-06-10T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function exch(over: Partial<ExchangeRecord> = {}): ExchangeRecord {
  return {
    name: over.name ?? 'Bybit', slug: over.slug ?? 'bybit', officialUrl: 'https://x', affiliateUrl: 'https://x',
    supportedGeos: ['*'], restrictedGeos: ['US'], kyc: 'basic', p2p: true, fiat: ['USD'],
    kazakhstan: { available: true, p2p: true, kyc: 'basic', fiat: ['KZT'], notes: '' },
    trustLevel: over.trustLevel ?? 'high', notes: '', lastReviewedAt: null,
    ...over,
  };
}

function bonus(over: Partial<BonusRecord> = {}): BonusRecord {
  return {
    id: over.id ?? 'b', exchangeSlug: over.exchangeSlug ?? 'bybit', type: over.type ?? 'bonus',
    title: over.title ?? 'New-user rewards', description: '', value: null, geos: ['*'],
    startDate: over.startDate ?? null, expiryDate: over.expiryDate ?? null,
    sourceUrl: 'https://x/bonus',
    verification: over.verification ?? { status: 'unverified', source: '', lastCheckedAt: null },
  };
}

function claim(over: Partial<VerificationClaim> = {}): VerificationClaim {
  return {
    id: over.id ?? 'bybit:KZ:p2p', exchangeSlug: over.exchangeSlug ?? 'bybit', country: 'KZ',
    type: over.type ?? 'p2p', assertion: 'true', evidence: [], conflicting: false,
    staleAfterDays: 30, lastCheckedAt: 'lastCheckedAt' in over ? over.lastCheckedAt! : null,
  };
}

function post(over: Partial<PostAnalyticsRecord> = {}): PostAnalyticsRecord {
  return {
    id: over.id ?? 'p', telegramMessageId: 1, channelId: '@c', title: 'T', link: '', source: 'S',
    category: over.category ?? 'Bonus', priority: 'HIGH', scoreTotal: over.scoreTotal ?? 70,
    exchangeMentions: over.exchangeMentions ?? ['bybit'], geoTags: over.geoTags ?? ['KZ'],
    publishedAt: daysAgo(1), updatedAt: daysAgo(1),
    metrics: over.metrics ?? { ...emptyMetrics(), reactions: 20, available: true },
  };
}

const baseInputs = (over: Partial<PlannerInputs> = {}): PlannerInputs => ({
  posts: over.posts ?? [],
  exchanges: over.exchanges ?? [exch(), exch({ name: 'LowX', slug: 'lowx', trustLevel: 'low' })],
  bonuses: over.bonuses ?? [],
  claims: over.claims ?? [],
  geo: 'KZ',
  now: NOW,
});

describe('topic prioritization (bonuses)', () => {
  it('verified+active bonus ranks high; unverified is downranked', () => {
    const verified = bonus({ id: 'v', verification: { status: 'verified', source: 's', lastCheckedAt: daysAgo(2) } });
    const unverified = bonus({ id: 'u' });
    const topics = bonusTopics([verified, unverified], [exch()], 'KZ', NOW);
    const v = topics.find((t) => t.id === 'bonus:v')!;
    const u = topics.find((t) => t.id === 'bonus:u')!;
    expect(v.priorityBand).toBe('high');
    expect(v.priority).toBeGreaterThan(u.priority);
    expect(u.requiredVerification).toBe('verified'); // must verify before publishing
  });
});

describe('downranking unverified / stale claims', () => {
  it('verification-update topics require verification and sit in the verification bucket', () => {
    const topics = verificationUpdateTopics([claim({ id: 'bybit:KZ:p2p', type: 'p2p' })], [exch()], 'KZ', NOW);
    expect(topics).toHaveLength(1);
    expect(topics[0].requiredVerification).toBe('verified');
    expect(bucketOf(topics[0].type)).toBe('verification');
  });

  it('high-trust exchange outranks low-trust for the same stale claim', () => {
    const topics = verificationUpdateTopics(
      [claim({ id: 'bybit:KZ:p2p', exchangeSlug: 'bybit', type: 'p2p' }),
       claim({ id: 'lowx:KZ:p2p', exchangeSlug: 'lowx', type: 'p2p' })],
      [exch(), exch({ slug: 'lowx', name: 'LowX', trustLevel: 'low' })],
      'KZ', NOW,
    );
    const hi = topics.find((t) => t.exchange === 'bybit')!;
    const lo = topics.find((t) => t.exchange === 'lowx')!;
    expect(hi.priority).toBeGreaterThan(lo.priority);
  });
});

describe('category coverage', () => {
  it('promotes the top category and flags underused ones', () => {
    const topics = categoryTopics([post({ category: 'Bonus' })], 'KZ');
    expect(topics.some((t) => t.id === 'cat-top:Bonus' && t.priorityBand === 'high')).toBe(true);
    expect(topics.some((t) => t.id.startsWith('cat-gap:'))).toBe(true); // e.g. KZ/Listing missing
  });
});

describe('locale / GEO gap detection', () => {
  it('flags primary KZ locales with no coverage', () => {
    const topics = localeGapTopics([], 'KZ');
    const ids = topics.map((t) => t.id);
    expect(ids).toContain('locale-gap:ru-KZ');
    expect(ids).toContain('locale-gap:kk-KZ');
  });

  it('excludes a locale once it has posts', () => {
    // A KZ post maps to ru-KZ → ru-KZ no longer a gap.
    const topics = localeGapTopics([post({ geoTags: ['KZ'] })], 'KZ');
    expect(topics.map((t) => t.id)).not.toContain('locale-gap:ru-KZ');
  });
});

describe('calendar generation + content mix', () => {
  const inputs = baseInputs({
    posts: [post({ category: 'Bonus' })],
    bonuses: [
      bonus({ id: 'v', type: 'launchpool', verification: { status: 'verified', source: 's', lastCheckedAt: daysAgo(2) } }),
      bonus({ id: 'u' }),
    ],
    claims: [claim({ id: 'bybit:KZ:p2p', type: 'p2p' }), claim({ id: 'bybit:KZ:kyc', type: 'kyc' })],
  });

  it('daily plan reports all five buckets with planned counts', () => {
    const plan = buildPlan(inputs, 'daily');
    expect(plan.contentMix.map((m) => m.bucket)).toEqual(['news', 'bonus', 'education', 'verification', 'evergreen']);
    const planned = Object.fromEntries(plan.contentMix.map((m) => [m.bucket, m.planned]));
    expect(planned).toEqual(DAILY_MIX);
  });

  it('never selects more than planned per bucket, and totals match', () => {
    const plan = buildPlan(inputs, 'daily');
    for (const m of plan.contentMix) expect(m.selected).toBeLessThanOrEqual(m.planned);
    const totalSelected = plan.contentMix.reduce((a, m) => a + m.selected, 0);
    expect(plan.topics).toHaveLength(totalSelected);
  });

  it('weekly plan uses the weekly mix and always carries the human-gate note', () => {
    const plan = buildPlan(inputs, 'weekly');
    const planned = Object.fromEntries(plan.contentMix.map((m) => [m.bucket, m.planned]));
    expect(planned).toEqual(WEEKLY_MIX);
    expect(plan.notes.some((n) => n.includes('Recommendations only'))).toBe(true);
  });

  it('warns when a bucket cannot be filled', () => {
    const plan = buildPlan(baseInputs(), 'daily'); // no bonuses/claims/posts
    expect(plan.notes.some((n) => n.startsWith('⚠️ bonus'))).toBe(true);
  });
});

describe('backlog + helpers', () => {
  it('bucketOf maps types correctly', () => {
    expect(bucketOf('launchpool')).toBe('bonus');
    expect(bucketOf('kyc')).toBe('verification');
    expect(bucketOf('regulation')).toBe('news');
    expect(bucketOf('evergreen')).toBe('evergreen');
    expect(band(80)).toBe('high');
    expect(band(50)).toBe('medium');
    expect(band(10)).toBe('low');
  });

  it('backlog returns a ranked, de-duplicated candidate list', () => {
    const list = backlog(baseInputs({
      bonuses: [bonus({ id: 'v', verification: { status: 'verified', source: 's', lastCheckedAt: daysAgo(2) } })],
    }));
    expect(list.length).toBeGreaterThan(0);
    // sorted by priority desc
    for (let i = 1; i < list.length; i++) expect(list[i - 1].priority).toBeGreaterThanOrEqual(list[i].priority);
    // unique ids
    expect(new Set(list.map((t) => t.id)).size).toBe(list.length);
  });
});
