import { describe, it, expect } from 'vitest';
import {
  buildTrends,
  emergingTopics,
  trendingExchanges,
  undercoveredTopics,
} from '../services/trend-engine';
import { emptyMetrics } from '../services/analytics-layer';
import { PostAnalyticsRecord, ResearchFinding } from '../src/types';

function finding(over: Partial<ResearchFinding> = {}): ResearchFinding {
  return {
    id: over.id ?? 'f', title: 'T', link: '', source: 'Cointelegraph',
    category: over.category ?? 'news', priority: over.priority ?? 'LOW',
    exchanges: over.exchanges ?? [], geos: over.geos ?? [], signals: over.signals ?? [],
    sourceTrust: 'trusted', confidence: 70, reason: '', humanVerificationRequired: true,
    foundAt: '2026-06-01T00:00:00.000Z',
  };
}

function post(exchangeMentions: string[], geoTags: string[] = ['Global']): PostAnalyticsRecord {
  return {
    id: `p${Math.random()}`, telegramMessageId: 1, channelId: '@c', title: 'T', link: '', source: 'S',
    category: 'Global', priority: 'MEDIUM', scoreTotal: 50, exchangeMentions, geoTags,
    publishedAt: '', updatedAt: '', metrics: { ...emptyMetrics(), reactions: 5, available: true },
  };
}

const findings = [
  finding({ id: 'a', exchanges: ['bybit'] }),
  finding({ id: 'b', exchanges: ['bybit'] }),
  finding({ id: 'c', exchanges: ['bybit'] }),
  finding({ id: 'd', exchanges: ['okx'] }),
];

describe('momentum', () => {
  it('most-mentioned exchange gets momentum 100, single mention scales down', () => {
    const ex = trendingExchanges(findings, []);
    const bybit = ex.find((t) => t.key === 'bybit')!;
    const okx = ex.find((t) => t.key === 'okx')!;
    expect(bybit.momentum).toBe(100);
    expect(bybit.count).toBe(3);
    expect(okx.momentum).toBe(33); // round(100/3)
  });
});

describe('status detection', () => {
  it('covered + high momentum → trending', () => {
    const ex = trendingExchanges(findings, [post(['bybit']), post(['bybit'])]);
    expect(ex.find((t) => t.key === 'bybit')!.status).toBe('trending');
  });

  it('research interest but zero coverage → undercovered', () => {
    const under = undercoveredTopics([finding({ exchanges: ['bybit'] }), finding({ exchanges: ['bybit'] })], []);
    expect(under.map((t) => t.key)).toContain('bybit');
  });

  it('single fresh mention → emerging', () => {
    // okx appears once; bybit covered so it is not the emerging one.
    const emerging = emergingTopics(findings, [post(['bybit']), post(['bybit'])]);
    expect(emerging.map((t) => t.key)).toContain('okx');
  });
});

describe('buildTrends', () => {
  it('aggregates kinds and sorts by momentum', () => {
    const trends = buildTrends(findings, [post(['bybit'])]);
    expect(trends.length).toBeGreaterThan(0);
    for (let i = 1; i < trends.length; i++) {
      expect(trends[i - 1].momentum).toBeGreaterThanOrEqual(trends[i].momentum);
    }
  });
});
