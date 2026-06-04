import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  AnalyticsStore,
  aggregateByCategory,
  aggregateByExchange,
  buildPostAnalytics,
  detectExchanges,
  detectGeo,
  emptyMetrics,
  engagementScore,
  topPosts,
} from '../services/analytics-layer';
import { buildFeedback, classifyPattern } from '../services/feedback-engine';
import { DraftRecord, PostAnalyticsRecord } from '../src/types';

/** Build a published DraftRecord fixture. */
function draft(over: Partial<DraftRecord> = {}): DraftRecord {
  return {
    id: over.id ?? 'd1',
    title: over.title ?? 'Bybit launches Launchpool campaign for Kazakhstan users',
    link: over.link ?? 'https://example.com',
    source: over.source ?? 'Cointelegraph',
    publishDate: over.publishDate ?? '2026-06-01T00:00:00.000Z',
    category: over.category ?? 'Bonus',
    scoreTotal: over.scoreTotal ?? 80,
    priority: over.priority ?? 'HIGH',
    text: over.text ?? 'Bybit opens a new Launchpool with rewards.',
    status: over.status ?? 'published',
    createdAt: over.createdAt ?? '2026-06-01T00:00:00.000Z',
    decidedAt: over.decidedAt ?? '2026-06-01T00:05:00.000Z',
    publishedAt: over.publishedAt ?? '2026-06-01T00:06:00.000Z',
    channelMessageId: over.channelMessageId ?? 111,
    ...over,
  };
}

/** Build a PostAnalyticsRecord fixture with controllable metrics. */
function post(over: Partial<PostAnalyticsRecord> = {}): PostAnalyticsRecord {
  return {
    id: over.id ?? 'p1',
    telegramMessageId: over.telegramMessageId ?? 1,
    channelId: over.channelId ?? '@cbwkz',
    title: over.title ?? 'Post',
    link: over.link ?? 'https://example.com',
    source: over.source ?? 'Decrypt',
    category: over.category ?? 'Global',
    priority: over.priority ?? 'MEDIUM',
    scoreTotal: over.scoreTotal ?? 50,
    exchangeMentions: over.exchangeMentions ?? [],
    geoTags: over.geoTags ?? ['Global'],
    publishedAt: over.publishedAt ?? '2026-06-01T00:00:00.000Z',
    metrics: over.metrics ?? emptyMetrics(),
    updatedAt: over.updatedAt ?? '2026-06-01T00:00:00.000Z',
  };
}

const tmpDirs: string[] = [];
function freshDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbw-analytics-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('analytics: detection', () => {
  it('detects exchanges from title + body', () => {
    expect(detectExchanges('Bybit and OKX announce listing')).toEqual(
      expect.arrayContaining(['bybit', 'okx']),
    );
    expect(detectExchanges('No exchange here')).toEqual([]);
  });

  it('detects KZ geo, else Global', () => {
    expect(detectGeo('Kaspi and Tenge support in Almaty')).toEqual(['KZ']);
    expect(detectGeo('Generic global crypto news')).toEqual(['Global']);
  });

  it('buildPostAnalytics derives mentions, geo and defaults metrics to unavailable', () => {
    const rec = buildPostAnalytics(draft(), 555, '@cbwkz', '2026-06-01T00:06:00.000Z');
    expect(rec.telegramMessageId).toBe(555);
    expect(rec.exchangeMentions).toContain('bybit');
    expect(rec.geoTags).toEqual(['KZ']);
    expect(rec.metrics.available).toBe(false);
    expect(engagementScore(rec.metrics)).toBe(0);
  });
});

describe('analytics: engagement + aggregation', () => {
  it('engagementScore is 0 when metrics unavailable', () => {
    expect(engagementScore(emptyMetrics())).toBe(0);
  });

  it('engagementScore weights forwards/reactions/views', () => {
    const m = { ...emptyMetrics(), views: 100, forwards: 4, reactions: 10, available: true };
    // 4*3 + 10*2 + round(100*0.1) = 12 + 20 + 10 = 42
    expect(engagementScore(m)).toBe(42);
  });

  it('aggregateByCategory sorts best engagement first', () => {
    const recs = [
      post({ id: 'a', category: 'Global', metrics: { ...emptyMetrics(), reactions: 1, available: true } }),
      post({ id: 'b', category: 'Bonus', metrics: { ...emptyMetrics(), reactions: 50, available: true } }),
    ];
    const agg = aggregateByCategory(recs);
    expect(agg[0].key).toBe('Bonus');
    expect(agg).toHaveLength(2);
  });

  it('aggregateByExchange buckets multi-mention posts and a none bucket', () => {
    const recs = [
      post({ id: 'a', exchangeMentions: ['bybit', 'okx'] }),
      post({ id: 'b', exchangeMentions: [] }),
    ];
    const keys = aggregateByExchange(recs).map((g) => g.key);
    expect(keys).toEqual(expect.arrayContaining(['bybit', 'okx', 'none']));
  });

  it('topPosts ranks by engagement then score', () => {
    const recs = [
      post({ id: 'low', scoreTotal: 90, metrics: { ...emptyMetrics(), reactions: 1, available: true } }),
      post({ id: 'high', scoreTotal: 30, metrics: { ...emptyMetrics(), reactions: 40, available: true } }),
    ];
    expect(topPosts(recs, 1)[0].id).toBe('high');
  });
});

describe('analytics: persistence', () => {
  it('tracks a published post and reloads it from disk', () => {
    const dir = freshDir();
    const store = new AnalyticsStore('post-analytics.json', dir);
    store.trackPublished(draft({ id: 'x1' }), 999, '@cbwkz');

    // New instance reads the same file.
    const reloaded = new AnalyticsStore('post-analytics.json', dir);
    const rec = reloaded.get('x1');
    expect(rec).toBeDefined();
    expect(rec!.telegramMessageId).toBe(999);
    expect(reloaded.all()).toHaveLength(1);
  });

  it('does not duplicate on re-track, and updateMetrics flips availability', () => {
    const dir = freshDir();
    const store = new AnalyticsStore('post-analytics.json', dir);
    store.trackPublished(draft({ id: 'x2' }), 1, '@cbwkz');
    store.trackPublished(draft({ id: 'x2' }), 2, '@cbwkz'); // re-track same id
    expect(store.all()).toHaveLength(1);

    const updated = store.updateMetrics('x2', { views: 500, forwards: 3, reactions: 7 });
    expect(updated!.metrics.available).toBe(true);
    expect(updated!.metrics.views).toBe(500);
    expect(engagementScore(updated!.metrics)).toBeGreaterThan(0);
  });

  it('updateMetrics on unknown id returns undefined', () => {
    const dir = freshDir();
    const store = new AnalyticsStore('post-analytics.json', dir);
    expect(store.updateMetrics('nope', { views: 1 })).toBeUndefined();
  });
});

describe('feedback: classification (foundation)', () => {
  it('high score + high engagement → successful', () => {
    const r = classifyPattern(
      post({ scoreTotal: 80, metrics: { ...emptyMetrics(), reactions: 40, available: true } }),
    );
    expect(r.classification).toBe('successful');
  });

  it('high score + near-zero engagement → weak', () => {
    const r = classifyPattern(
      post({ scoreTotal: 80, metrics: { ...emptyMetrics(), reactions: 1, available: true } }),
    );
    expect(r.classification).toBe('weak');
  });

  it('no metrics → no_data', () => {
    const r = classifyPattern(post({ scoreTotal: 80 }));
    expect(r.classification).toBe('no_data');
  });

  it('mid score + mid engagement → neutral', () => {
    const r = classifyPattern(
      post({ scoreTotal: 50, metrics: { ...emptyMetrics(), reactions: 5, available: true } }),
    );
    expect(r.classification).toBe('neutral');
  });

  it('buildFeedback counts successful and weak patterns', () => {
    const summary = buildFeedback([
      post({ id: 's', scoreTotal: 80, metrics: { ...emptyMetrics(), reactions: 40, available: true } }),
      post({ id: 'w', scoreTotal: 80, metrics: { ...emptyMetrics(), reactions: 1, available: true } }),
      post({ id: 'n', scoreTotal: 80 }),
    ]);
    expect(summary.successfulCount).toBe(1);
    expect(summary.weakCount).toBe(1);
    expect(summary.patterns).toHaveLength(3);
  });
});
