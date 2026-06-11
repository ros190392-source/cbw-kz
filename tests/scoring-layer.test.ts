import { describe, it, expect } from 'vitest';
import { scoreItem, freshnessScore, coverageScore } from '../services/scoring-layer';
import { NewsItem } from '../src/types';

/**
 * Regression suite for the scoring layer — the editorial brain of CBW (global).
 *
 * These tests pin the behaviour we must never silently break:
 *   - popularity (freshness + cross-source coverage) is prioritized,
 *   - exchange / bonus / launchpool content is prioritized (CBW monetization),
 *   - hype / meme / low-signal market noise is rejected,
 *   - priority classification stays stable.
 *
 * Source weight is intentionally omitted (defaults to 0) so the tests exercise
 * the scoring logic itself, independent of which feed an item came from.
 */
function item(title: string, summary = '', publishDate?: string): NewsItem {
  return {
    id: 'test',
    title,
    link: 'https://example.com',
    source: 'Test',
    sourceId: 'test',
    publishDate: publishDate ?? new Date().toISOString(),
    summary,
  };
}

describe('scoring-layer: popularity (freshness + coverage)', () => {
  it('1. fresh story covered by 3 sources → HIGH priority (trending floor)', () => {
    const r = scoreItem(
      item('Bitcoin ETF sees record inflows as BlackRock expands holdings'),
      0,
      { crossSourceCount: 3 },
    );
    expect(r.priority).toBe('HIGH');
    expect(r.popularity_score).toBeGreaterThanOrEqual(20);
    expect(r.score_total).toBeGreaterThanOrEqual(65);
    expect(r.reason).toContain('trending');
  });

  it('2. same story single-source scores lower than multi-source', () => {
    const title = 'SEC approves new crypto ETF rule for institutional investors';
    const single = scoreItem(item(title), 0, { crossSourceCount: 1 });
    const multi = scoreItem(item(title), 0, { crossSourceCount: 3 });
    expect(multi.score_total).toBeGreaterThan(single.score_total);
  });

  it('3. freshnessScore decays with age', () => {
    const now = new Date('2026-06-11T12:00:00Z');
    expect(freshnessScore('2026-06-11T10:00:00Z', now)).toBe(10); // 2h old
    expect(freshnessScore('2026-06-11T02:00:00Z', now)).toBe(7);  // 10h old
    expect(freshnessScore('2026-06-10T14:00:00Z', now)).toBe(4);  // 22h old
    expect(freshnessScore('2026-06-09T12:00:00Z', now)).toBe(0);  // 48h old
    expect(freshnessScore('2026-06-12T12:00:00Z', now)).toBe(0);  // future-dated
  });

  it('4. coverageScore steps at 2 and 3 sources', () => {
    expect(coverageScore(1)).toBe(0);
    expect(coverageScore(2)).toBe(8);
    expect(coverageScore(3)).toBe(15);
    expect(coverageScore(5)).toBe(15);
  });

  it('5. stale single-source story gets zero popularity', () => {
    const r = scoreItem(item('Generic crypto update', '', '2026-01-01T00:00:00Z'), 0, {
      crossSourceCount: 1,
      now: new Date('2026-06-11T12:00:00Z'),
    });
    expect(r.popularity_score).toBe(0);
  });
});

describe('scoring-layer: exchange / bonus priority', () => {
  it('6. Launchpool/bonus news → HIGH priority', () => {
    const r = scoreItem(item('Bybit launches new Launchpool campaign with rewards for new users'));
    expect(r.priority).toBe('HIGH');
    expect(['Bonus', 'Launchpool']).toContain(r.category);
    expect(r.exchange_bonus_score).toBeGreaterThanOrEqual(15);
    expect(r.score_total).toBeGreaterThanOrEqual(60);
  });

  it('7. Exchange listing/campaign → HIGH or MEDIUM', () => {
    const r = scoreItem(item('OKX announces new spot listing and trading campaign'));
    expect(['HIGH', 'MEDIUM']).toContain(r.priority);
    expect(r.exchange_bonus_score).toBeGreaterThan(0);
    expect(r.score_total).toBeGreaterThanOrEqual(45);
  });
});

describe('scoring-layer: global / regulation', () => {
  it('8. Global regulation → kept (not REJECT), category Regulation', () => {
    const r = scoreItem(item('SEC approves new crypto ETF rule for institutional investors'));
    expect(r.priority).not.toBe('REJECT');
    expect(r.category).toBe('Regulation');
    expect(r.score_total).toBeGreaterThanOrEqual(25);
  });

  it('9. categories map to global buckets (no KZ category)', () => {
    expect(scoreItem(item('Major exchange hack drains millions')).category).toBe('Security');
    expect(scoreItem(item('Bitcoin network upgrade ships quietly')).category).toBe('Bitcoin');
    expect(scoreItem(item('Kazakhstan introduces new crypto exchange rules in Astana')).category).not.toBe('KZ');
  });
});

describe('scoring-layer: hype / noise rejection', () => {
  it('10. Meme coin hype → REJECT, score ~0', () => {
    const r = scoreItem(item('This meme coin could 100x to the moon according to influencers', '', '2026-01-01T00:00:00Z'), 0, {
      now: new Date('2026-06-11T12:00:00Z'),
    });
    expect(r.priority).toBe('REJECT');
    expect(r.score_total).toBeLessThanOrEqual(5);
  });

  it('11. Low-signal market movement → REJECT', () => {
    // Stale date so freshness cannot lift pure price chatter over the floor.
    const r = scoreItem(item('Bitcoin rises 1% as traders eye resistance level', '', '2026-01-01T00:00:00Z'), 0, {
      now: new Date('2026-06-11T12:00:00Z'),
    });
    expect(r.priority).toBe('REJECT');
  });

  it('12. Weak price speculation → REJECT', () => {
    const r = scoreItem(item('Ethereum price may move higher as analysts watch the market', '', '2026-01-01T00:00:00Z'), 0, {
      now: new Date('2026-06-11T12:00:00Z'),
    });
    expect(r.priority).toBe('REJECT');
  });
});

describe('scoring-layer: invariants', () => {
  it('subscores always stay within their declared ranges', () => {
    const samples = [
      'Bybit Launchpool bonus campaign rewards listing airdrop referral competition',
      'SEC ETF BlackRock hack exploit regulation institutional billion',
      'Bitcoin Ethereum stablecoin CBDC halving tokenized',
      '',
    ];
    for (const t of samples) {
      const r = scoreItem(item(t), 0, { crossSourceCount: 5 });
      expect(r.importance_score).toBeGreaterThanOrEqual(0);
      expect(r.importance_score).toBeLessThanOrEqual(25);
      expect(r.popularity_score).toBeLessThanOrEqual(25);
      expect(r.exchange_bonus_score).toBeLessThanOrEqual(20);
      expect(r.user_value_score).toBeLessThanOrEqual(20);
      expect(r.trust_score).toBeLessThanOrEqual(10);
      expect(r.score_total).toBeGreaterThanOrEqual(0);
      expect(r.score_total).toBeLessThanOrEqual(100);
      expect(['HIGH', 'MEDIUM', 'LOW', 'REJECT']).toContain(r.priority);
    }
  });
});
