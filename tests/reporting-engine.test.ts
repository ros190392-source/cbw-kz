import { describe, it, expect } from 'vitest';
import { buildReport, formatReport, windowStart } from '../services/reporting-engine';
import { emptyMetrics } from '../services/analytics-layer';
import { DraftRecord, PostAnalyticsRecord } from '../src/types';

const NOW = new Date('2026-06-10T12:00:00.000Z');

function post(over: Partial<PostAnalyticsRecord> = {}): PostAnalyticsRecord {
  return {
    id: over.id ?? 'p',
    telegramMessageId: over.telegramMessageId ?? 1,
    channelId: '@cbwkz',
    title: over.title ?? 'Post',
    link: 'https://example.com',
    source: 'Decrypt',
    category: over.category ?? 'Global',
    priority: over.priority ?? 'MEDIUM',
    scoreTotal: over.scoreTotal ?? 50,
    exchangeMentions: over.exchangeMentions ?? [],
    geoTags: ['Global'],
    publishedAt: over.publishedAt ?? '2026-06-10T00:00:00.000Z',
    metrics: over.metrics ?? emptyMetrics(),
    updatedAt: over.publishedAt ?? '2026-06-10T00:00:00.000Z',
  };
}

function draft(over: Partial<DraftRecord> = {}): DraftRecord {
  return {
    id: over.id ?? 'd',
    title: 'T',
    link: 'https://example.com',
    source: 'Decrypt',
    publishDate: '2026-06-10T00:00:00.000Z',
    category: 'Global',
    scoreTotal: 50,
    priority: 'MEDIUM',
    text: 'body',
    status: over.status ?? 'published',
    createdAt: '2026-06-10T00:00:00.000Z',
    decidedAt: over.decidedAt ?? '2026-06-10T00:05:00.000Z',
    publishedAt: over.publishedAt ?? '2026-06-10T00:06:00.000Z',
    ...over,
  };
}

describe('reporting: window', () => {
  it('daily window is 24h, weekly is 7d', () => {
    expect(windowStart('daily', NOW).toISOString()).toBe('2026-06-09T12:00:00.000Z');
    expect(windowStart('weekly', NOW).toISOString()).toBe('2026-06-03T12:00:00.000Z');
  });
});

describe('reporting: buildReport', () => {
  it('counts only posts inside the window', () => {
    const posts = [
      post({ id: 'in', publishedAt: '2026-06-10T01:00:00.000Z' }),
      post({ id: 'old', publishedAt: '2026-06-01T00:00:00.000Z' }), // outside daily
    ];
    const r = buildReport({ posts, drafts: [], period: 'daily', now: NOW });
    expect(r.totalPublished).toBe(1);
  });

  it('computes approval/rejection counts and publish success rate', () => {
    const drafts = [
      draft({ id: 'a', status: 'published' }),
      draft({ id: 'b', status: 'approved' }), // approved but publish failed
      draft({ id: 'c', status: 'rejected' }),
    ];
    const posts = [post({ id: 'a', publishedAt: '2026-06-10T00:06:00.000Z' })];
    const r = buildReport({ posts, drafts, period: 'daily', now: NOW });
    expect(r.approvalCount).toBe(2); // published + approved
    expect(r.rejectedCount).toBe(1);
    // published=1, approved=2 → 0.5
    expect(r.publishSuccessRate).toBe(0.5);
  });

  it('picks top post, top category and top exchange', () => {
    const posts = [
      post({
        id: 'hi', category: 'Bonus', exchangeMentions: ['bybit'], scoreTotal: 90,
        publishedAt: '2026-06-10T01:00:00.000Z',
        metrics: { ...emptyMetrics(), reactions: 50, available: true },
      }),
      post({
        id: 'lo', category: 'Global', scoreTotal: 40,
        publishedAt: '2026-06-10T02:00:00.000Z',
        metrics: { ...emptyMetrics(), reactions: 1, available: true },
      }),
    ];
    const r = buildReport({ posts, drafts: [], period: 'daily', now: NOW });
    expect(r.topPost?.id).toBe('hi');
    expect(r.topCategory).toBe('Bonus');
    expect(r.topExchange).toBe('bybit');
    expect(r.averageScore).toBe(65); // (90+40)/2
  });

  it('empty input → zeros, rate defaults to 1, formats without throwing', () => {
    const r = buildReport({ posts: [], drafts: [], period: 'weekly', now: NOW });
    expect(r.totalPublished).toBe(0);
    expect(r.publishSuccessRate).toBe(1);
    expect(r.topPost).toBeNull();
    const text = formatReport(r);
    expect(text).toContain('Weekly report');
    expect(text).toContain('No posts published');
  });
});
