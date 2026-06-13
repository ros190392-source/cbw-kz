import { describe, it, expect } from 'vitest';
import { detectExchange, funnelUrl, buildFunnelFooter, SITE_BASE, UTM } from '../services/funnel';
import { buildNewsCaption } from '../services/autopublish/news';
import { DraftRecord } from '../src/types';

function draft(over: Partial<DraftRecord> = {}): DraftRecord {
  return {
    id: 'd1',
    title: 'Bybit launches new launchpool with token rewards',
    link: 'https://example.com/news',
    source: 'The Block',
    publishDate: '2026-06-11T08:00:00.000Z',
    category: 'Bonus',
    scoreTotal: 70,
    priority: 'HIGH',
    text: 'Bybit announced a new launchpool round for users staking stablecoins.',
    status: 'pending',
    createdAt: '2026-06-11T08:05:00.000Z',
  } as DraftRecord;
}

describe('detectExchange', () => {
  it('finds a CBW-listed exchange in the text', () => {
    expect(detectExchange('Bybit launches new perpetual contracts')?.slug).toBe('bybit');
    expect(detectExchange('MEXC lists three new tokens')?.slug).toBe('mexc');
  });

  it('picks the most-mentioned exchange when several appear', () => {
    const t = 'Binance and Bybit both listed the token, but Bybit also added a Bybit launchpool';
    expect(detectExchange(t)?.slug).toBe('bybit');
  });

  it('matches HTX only as a word, and via the Huobi alias', () => {
    expect(detectExchange('HTX adds new staking program')?.slug).toBe('htx');
    expect(detectExchange('Huobi rebrand anniversary')?.slug).toBe('htx');
  });

  it('returns null for news without a listed exchange', () => {
    expect(detectExchange('Bitcoin hits new all-time high amid ETF inflows')).toBeNull();
  });
});

describe('funnelUrl', () => {
  it('routes to the exchange page with UTM tags', () => {
    expect(funnelUrl({ slug: 'okx', name: 'OKX' })).toBe(`${SITE_BASE}/exchanges/okx/?${UTM}`);
  });

  it('falls back to the bonuses index', () => {
    expect(funnelUrl(null)).toBe(`${SITE_BASE}/bonuses/?${UTM}`);
  });
});

describe('buildFunnelFooter', () => {
  it('is exchange-specific for exchange news', () => {
    const f = buildFunnelFooter('KuCoin announces trading competition');
    expect(f).toContain('KuCoin bonuses & promo codes');
    expect(f).toContain('/exchanges/kucoin/');
  });

  it('is generic otherwise and never claims amounts', () => {
    const f = buildFunnelFooter('Ethereum upgrade ships on mainnet');
    expect(f).toContain('Best exchange bonuses today');
    expect(f).toContain('/bonuses/');
    expect(f).not.toMatch(/\$\d/);
  });
});

describe('buildNewsCaption with funnel', () => {
  it('attributes the source and routes the funnel footer after it', () => {
    const c = buildNewsCaption(draft());
    expect(c).toContain('The Block');                 // source (wording varies)
    expect(c).toContain('/exchanges/bybit/?utm_source=telegram'); // exchange-routed CTA
    // attribution (with the link) always precedes the funnel footer
    expect(c.indexOf('/exchanges/bybit/')).toBeGreaterThan(c.indexOf('The Block'));
  });

  it('stays within the 1024-char Telegram caption limit and keeps the CTA', () => {
    const c = buildNewsCaption(draft({ text: 'x'.repeat(2000) }));
    expect(c.length).toBeLessThanOrEqual(1024);
    expect(c).toContain('/exchanges/bybit/'); // funnel survived the trim
    expect(c).toContain('The Block');
  });
});
