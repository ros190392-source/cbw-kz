import { describe, it, expect } from 'vitest';
import { scoreItem } from '../services/scoring-layer';
import { NewsItem } from '../src/types';

/**
 * Regression suite for the scoring layer — the editorial brain of CBW KZ.
 *
 * These tests pin the behaviour we must never silently break:
 *   - Kazakhstan relevance is prioritized,
 *   - exchange / bonus / launchpool content is prioritized (CBW monetization),
 *   - hype / meme / low-signal market noise is rejected,
 *   - priority classification stays stable.
 *
 * Source weight is intentionally omitted (defaults to 0) so the tests exercise
 * the scoring logic itself, independent of which feed an item came from.
 */
function item(title: string, summary = ''): NewsItem {
  return {
    id: 'test',
    title,
    link: 'https://example.com',
    source: 'Test',
    sourceId: 'test',
    publishDate: new Date().toISOString(),
    summary,
  };
}

describe('scoring-layer: Kazakhstan relevance', () => {
  it('1. KZ news → HIGH priority', () => {
    const r = scoreItem(item('Binance expands P2P support for Kazakhstan users with KZT and Kaspi payments'));
    expect(r.priority).toBe('HIGH');
    expect(['KZ', 'P2P']).toContain(r.category);
    expect(r.kz_relevance_score).toBeGreaterThan(0);
    expect(r.score_total).toBeGreaterThanOrEqual(60);
  });

  it('8. Kazakhstan regulation → HIGH/MEDIUM, KZ relevance boosted', () => {
    const r = scoreItem(item('Kazakhstan introduces new crypto exchange regulation in Astana'));
    expect(['HIGH', 'MEDIUM']).toContain(r.priority);
    expect(r.kz_relevance_score).toBeGreaterThan(10);
    expect(['KZ', 'Regulation']).toContain(r.category);
  });
});

describe('scoring-layer: exchange / bonus priority', () => {
  it('2. Launchpool/bonus news → HIGH priority', () => {
    const r = scoreItem(item('Bybit launches new Launchpool campaign with rewards for new users'));
    expect(r.priority).toBe('HIGH');
    expect(['Bonus', 'Launchpool']).toContain(r.category);
    expect(r.exchange_bonus_score).toBeGreaterThanOrEqual(15);
    expect(r.score_total).toBeGreaterThanOrEqual(60);
  });

  it('3. Exchange listing/campaign → HIGH or MEDIUM', () => {
    const r = scoreItem(item('OKX announces new spot listing and trading campaign'));
    expect(['HIGH', 'MEDIUM']).toContain(r.priority);
    expect(r.exchange_bonus_score).toBeGreaterThan(0);
    expect(r.score_total).toBeGreaterThanOrEqual(45);
  });
});

describe('scoring-layer: global / regulation', () => {
  it('4. Global regulation → kept (not REJECT), category Regulation', () => {
    const r = scoreItem(item('SEC approves new crypto ETF rule for institutional investors'));
    expect(r.priority).not.toBe('REJECT');
    expect(r.category).toBe('Regulation');
    expect(r.score_total).toBeGreaterThanOrEqual(25);
  });
});

describe('scoring-layer: hype / noise rejection', () => {
  it('5. Meme coin hype → REJECT, score ~0', () => {
    const r = scoreItem(item('This meme coin could 100x to the moon according to influencers'));
    expect(r.priority).toBe('REJECT');
    expect(r.score_total).toBeLessThanOrEqual(5);
  });

  it('6. Low-signal market movement → REJECT', () => {
    const r = scoreItem(item('Bitcoin rises 1% as traders eye resistance level'));
    expect(r.priority).toBe('REJECT');
  });

  it('7. Weak price speculation → REJECT', () => {
    const r = scoreItem(item('Ethereum price may move higher as analysts watch the market'));
    expect(r.priority).toBe('REJECT');
  });
});

describe('scoring-layer: invariants', () => {
  it('subscores always stay within their declared ranges', () => {
    const samples = [
      'Bybit Launchpool bonus campaign rewards listing airdrop referral competition',
      'Kazakhstan Astana Almaty Tenge KZT Kaspi Halyk Freedom Bank AIFC',
      'SEC ETF BlackRock hack exploit regulation institutional billion',
      '',
    ];
    for (const t of samples) {
      const r = scoreItem(item(t));
      expect(r.importance_score).toBeGreaterThanOrEqual(0);
      expect(r.importance_score).toBeLessThanOrEqual(25);
      expect(r.kz_relevance_score).toBeLessThanOrEqual(25);
      expect(r.exchange_bonus_score).toBeLessThanOrEqual(20);
      expect(r.user_value_score).toBeLessThanOrEqual(20);
      expect(r.trust_score).toBeLessThanOrEqual(10);
      expect(r.score_total).toBeGreaterThanOrEqual(0);
      expect(r.score_total).toBeLessThanOrEqual(100);
      expect(['HIGH', 'MEDIUM', 'LOW', 'REJECT']).toContain(r.priority);
    }
  });
});
