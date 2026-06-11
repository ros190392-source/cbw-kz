import { describe, it, expect } from 'vitest';
import {
  EngagementIndex,
  EMPTY_ENGAGEMENT,
  significantTokens,
  redditHeat,
  cryptoPanicHeat,
} from '../services/engagement';
import { scoreItem } from '../services/scoring-layer';
import { NewsItem } from '../src/types';

function item(over: Partial<NewsItem> = {}): NewsItem {
  return {
    id: 'x1',
    title: 'BlackRock spot Ethereum ETF approved by SEC',
    link: 'https://example.com/a',
    summary: 'The SEC approved the BlackRock spot Ethereum ETF for institutional trading.',
    publishDate: '2026-01-01T00:00:00.000Z',
    source: 'Test',
    sourceId: 'test',
    ...over,
  };
}

describe('significantTokens', () => {
  it('keeps meaningful words, drops stopwords and short tokens', () => {
    const t = significantTokens('SEC says it will approve the BlackRock Ethereum ETF today');
    expect(t.has('blackrock')).toBe(true);
    expect(t.has('ethereum')).toBe(true);
    expect(t.has('approve')).toBe(true);
    expect(t.has('says')).toBe(false);  // stopword
    expect(t.has('sec')).toBe(true);    // short crypto term whitelist
    expect(t.has('etf')).toBe(true);
    expect(t.has('today')).toBe(false); // stopword
  });

  it('stems inflected forms onto the same token', () => {
    const a = significantTokens('SEC approves the listing');
    const b = significantTokens('Listing approved by SEC');
    expect([...a].filter((t) => b.has(t)).length).toBeGreaterThanOrEqual(3);
  });
});

describe('heat scaling', () => {
  it('reddit upvotes map to 0-10', () => {
    expect(redditHeat(1000)).toBe(10);
    expect(redditHeat(250)).toBe(7);
    expect(redditHeat(60)).toBe(4);
    expect(redditHeat(15)).toBe(2);
    expect(redditHeat(3)).toBe(0);
  });

  it('cryptopanic votes map to 0-10', () => {
    expect(cryptoPanicHeat({ positive: 25, important: 10 })).toBe(10);
    expect(cryptoPanicHeat({ positive: 8, liked: 3 })).toBe(7);
    expect(cryptoPanicHeat({ positive: 3 })).toBe(4);
    expect(cryptoPanicHeat({ liked: 1 })).toBe(2);
    expect(cryptoPanicHeat({})).toBe(0);
  });
});

describe('EngagementIndex.boostFor', () => {
  const index = new EngagementIndex([
    { title: 'BlackRock Ethereum ETF officially approved by the SEC!', heat: 10 },
    { title: 'Solana network outage continues for hours', heat: 4 },
  ]);

  it('matches the same story worded differently', () => {
    // shares: blackrock, ethereum, approved (3 tokens)
    expect(index.boostFor('SEC approves BlackRock spot Ethereum ETF')).toBe(10);
  });

  it('does not match unrelated stories', () => {
    expect(index.boostFor('Dogecoin merch store opens in Tokyo mall')).toBe(0);
  });

  it('takes the highest heat among matches', () => {
    const multi = new EngagementIndex([
      { title: 'BlackRock Ethereum ETF approved by regulators', heat: 4 },
      { title: 'Breaking: BlackRock spot Ethereum ETF approved', heat: 10 },
    ]);
    expect(multi.boostFor('BlackRock Ethereum ETF approved — what it means')).toBe(10);
  });

  it('short/generic titles never match', () => {
    expect(index.boostFor('ETF news')).toBe(0);
  });

  it('empty index always returns 0', () => {
    expect(EMPTY_ENGAGEMENT.boostFor('BlackRock spot Ethereum ETF approved by SEC')).toBe(0);
    expect(EMPTY_ENGAGEMENT.size).toBe(0);
  });
});

describe('trending coins (CoinGecko)', () => {
  const index = new EngagementIndex([], [
    { name: 'Pudgy Penguins', symbol: 'PENGU' },
    { name: 'Bonk', symbol: 'BONK' },
  ]);

  it('boosts headlines naming a trending coin', () => {
    expect(index.boostFor('Pudgy Penguins NFT floor hits all-time high')).toBe(5);
  });

  it('boosts headlines with a trending ticker', () => {
    expect(index.boostFor('Exchange lists BONK perpetual futures')).toBe(5);
  });

  it('ticker must be uppercase whole-word — no false hits', () => {
    expect(index.boostFor('New zealand bonkers crypto tax rules explained')).toBe(0);
  });

  it('story heat wins over trending heat when higher', () => {
    const both = new EngagementIndex(
      [{ title: 'Bonk token exchange listing perpetual futures launch', heat: 10 }],
      [{ name: 'Bonk', symbol: 'BONK' }],
    );
    expect(both.boostFor('Exchange listing for Bonk perpetual futures launches')).toBe(10);
  });
});

describe('scoring integration', () => {
  it('engagement boost raises popularity_score', () => {
    const base = scoreItem(item(), 0, { now: new Date('2026-06-01T00:00:00Z') });
    const boosted = scoreItem(item(), 0, { now: new Date('2026-06-01T00:00:00Z'), engagementBoost: 10 });
    expect(boosted.popularity_score).toBe(base.popularity_score + 10);
    expect(boosted.score_total).toBeGreaterThan(base.score_total);
  });

  it('hot engagement + importance triggers the trending floor', () => {
    const r = scoreItem(item(), 0, { now: new Date('2026-06-01T00:00:00Z'), engagementBoost: 8 });
    expect(r.importance_score).toBeGreaterThanOrEqual(8);
    expect(r.score_total).toBeGreaterThanOrEqual(70);
    expect(r.priority).toBe('HIGH');
  });

  it('popularity stays clamped at 25', () => {
    const r = scoreItem(item({ publishDate: new Date().toISOString() }), 0, {
      crossSourceCount: 3,
      engagementBoost: 10,
    });
    expect(r.popularity_score).toBe(25);
  });

  it('mentions engagement in the reason when hot', () => {
    const r = scoreItem(item(), 0, { now: new Date('2026-06-01T00:00:00Z'), engagementBoost: 7 });
    expect(r.reason).toContain('hot on socials');
  });
});
