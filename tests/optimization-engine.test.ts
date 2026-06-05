import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  OptimizationStore,
  buildOptimization,
  confidenceFromSample,
  engagementPatternSuggestions,
  localeFocusSuggestions,
  scoringSuggestions,
  sourceTrustSuggestions,
  topicPrioritySuggestions,
  verificationWarnings,
} from '../services/optimization-engine';
import { emptyMetrics } from '../services/analytics-layer';
import { PostAnalyticsRecord, VerificationClaim } from '../src/types';

const NOW = new Date('2026-06-10T12:00:00.000Z');
let pid = 0;

function post(over: Partial<PostAnalyticsRecord> & { reactions?: number } = {}): PostAnalyticsRecord {
  return {
    id: `p${pid++}`, telegramMessageId: 1, channelId: '@c', title: 'T', link: '', source: over.source ?? 'SrcA',
    category: over.category ?? 'Global', priority: 'MEDIUM', scoreTotal: over.scoreTotal ?? 50,
    exchangeMentions: over.exchangeMentions ?? [], geoTags: over.geoTags ?? ['Global'],
    publishedAt: '2026-06-09T00:00:00.000Z', updatedAt: '2026-06-09T00:00:00.000Z',
    metrics: { ...emptyMetrics(), reactions: over.reactions ?? 0, available: over.reactions != null },
  };
}

function claim(over: Partial<VerificationClaim> = {}): VerificationClaim {
  return {
    id: over.id ?? 'bybit:KZ:p2p', exchangeSlug: 'bybit', country: 'KZ', type: over.type ?? 'p2p',
    assertion: 'true', evidence: over.evidence ?? [], conflicting: false, staleAfterDays: 30,
    lastCheckedAt: 'lastCheckedAt' in over ? over.lastCheckedAt! : null, // null → stale
  };
}

const tmpDirs: string[] = [];
function freshDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cbw-opt-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// Bonus = high engagement / low score; Regulation = high score / low engagement.
const mixedPosts = [
  ...Array.from({ length: 3 }, () => post({ category: 'Bonus', scoreTotal: 40, reactions: 50 })),
  ...Array.from({ length: 3 }, () => post({ category: 'Regulation', scoreTotal: 90, reactions: 2 })),
];

describe('confidence from sample size', () => {
  it('gates confidence by data volume', () => {
    expect(confidenceFromSample(8)).toBe('high');
    expect(confidenceFromSample(3)).toBe('medium');
    expect(confidenceFromSample(2)).toBe('low');
  });
});

describe('scoring-weight suggestions', () => {
  it('increases under-rated, decreases over-rated categories', () => {
    const s = scoringSuggestions(mixedPosts);
    const bonus = s.find((x) => x.target === 'category:Bonus')!;
    const reg = s.find((x) => x.target === 'category:Regulation')!;
    expect(bonus.direction).toBe('increase');
    expect(reg.direction).toBe('decrease');
  });

  it('returns nothing with fewer than two categories', () => {
    expect(scoringSuggestions([post({ category: 'Bonus', reactions: 10 })])).toEqual([]);
  });
});

describe('source-trust suggestions', () => {
  it('raises strong sources and lowers weak ones', () => {
    const posts = [
      post({ source: 'StrongFeed', reactions: 50 }), post({ source: 'StrongFeed', reactions: 50 }),
      post({ source: 'WeakFeed', reactions: 1 }), post({ source: 'WeakFeed', reactions: 1 }),
    ];
    const s = sourceTrustSuggestions(posts);
    expect(s.find((x) => x.target === 'source:StrongFeed')!.direction).toBe('increase');
    expect(s.find((x) => x.target === 'source:WeakFeed')!.direction).toBe('decrease');
  });
});

describe('topic-priority suggestions (planner loop)', () => {
  it('promotes the best and demotes the weakest category', () => {
    const s = topicPrioritySuggestions(mixedPosts);
    expect(s.find((x) => x.target === 'topic:Bonus')!.direction).toBe('increase');
    expect(s.find((x) => x.target === 'topic:Regulation')!.direction).toBe('decrease');
  });
});

describe('locale focus suggestions', () => {
  it('maintains the top locale and flags uncovered primary locales', () => {
    const s = localeFocusSuggestions([post({ geoTags: ['KZ'], reactions: 30 })]);
    expect(s.find((x) => x.target === 'locale:ru-KZ')!.direction).toBe('maintain');
    // kk-KZ has no posts → investigate
    expect(s.find((x) => x.target === 'locale:kk-KZ')!.direction).toBe('investigate');
  });
});

describe('verification refresh warnings', () => {
  it('flags stale claims for re-verification', () => {
    const s = verificationWarnings([claim({ id: 'bybit:KZ:p2p' })], NOW);
    expect(s).toHaveLength(1);
    expect(s[0].type).toBe('verification_refresh');
    expect(s[0].direction).toBe('investigate');
  });

  it('is empty when nothing is stale', () => {
    const fresh = claim({ id: 'x', lastCheckedAt: '2026-06-09T00:00:00.000Z' });
    expect(verificationWarnings([fresh], NOW)).toEqual([]);
  });
});

describe('engagement-pattern learning', () => {
  it('surfaces successful and weak patterns', () => {
    const posts = [
      post({ scoreTotal: 80, reactions: 40 }), // successful (eng 80)
      post({ scoreTotal: 80, reactions: 1 }),  // weak (eng 2)
    ];
    const s = engagementPatternSuggestions(posts);
    expect(s.find((x) => x.target === 'successful_patterns')!.direction).toBe('increase');
    expect(s.find((x) => x.target === 'weak_patterns')!.direction).toBe('investigate');
  });
});

describe('buildOptimization snapshot', () => {
  it('aggregates suggestions, summarizes by type, and always carries the human-review note', () => {
    const snap = buildOptimization({ posts: mixedPosts, claims: [claim()], now: NOW });
    expect(snap.summary.total).toBe(snap.suggestions.length);
    expect(Object.keys(snap.summary.byType).length).toBeGreaterThan(0);
    expect(snap.notes.some((n) => n.includes('Recommendations only'))).toBe(true);
    expect(snap.suggestions.every((s) => s.humanReviewRequired)).toBe(true);
  });

  it('warns on low data volume', () => {
    const snap = buildOptimization({ posts: [post({ reactions: 5 })], claims: [], now: NOW });
    expect(snap.notes.some((n) => n.includes('Low data volume'))).toBe(true);
  });
});

describe('OptimizationStore persistence', () => {
  it('appends snapshots and returns the latest', () => {
    const dir = freshDir();
    const store = new OptimizationStore('optimization-snapshots.json', dir);
    store.save(buildOptimization({ posts: mixedPosts, claims: [], now: NOW }));
    store.save(buildOptimization({ posts: mixedPosts, claims: [claim()], now: NOW }));
    expect(store.history()).toHaveLength(2);
    expect(store.latest()).not.toBeNull();
  });
});
