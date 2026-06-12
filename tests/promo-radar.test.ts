import { describe, it, expect } from 'vitest';
import {
  PromoItem,
  isRewardPromo,
  isGlobalPromo,
  isEligiblePromo,
  selectPromo,
  MAX_PROMO_AGE_H,
} from '../services/promo-radar';

const NOW = new Date('2026-06-12T15:30:00Z');

function promo(opts: Partial<PromoItem> = {}): PromoItem {
  return {
    exchangeSlug: opts.exchangeSlug ?? 'bybit',
    exchangeName: opts.exchangeName ?? 'Bybit',
    title: opts.title ?? 'Trade to share up to 100,000 USDT in rewards',
    url: opts.url ?? 'https://announcements.bybit.com/en-US/article/x/',
    publishedAt: opts.publishedAt ?? NOW.getTime() - 60 * 60 * 1000,
    endsAt: opts.endsAt !== undefined ? opts.endsAt : null,
  };
}

describe('isRewardPromo', () => {
  it('accepts titles that offer something', () => {
    expect(isRewardPromo('Share up to 100,000 USDT in rewards')).toBe(true);
    expect(isRewardPromo('Deposit & win a lucky draw prize')).toBe(true);
    expect(isRewardPromo('KGST Flexible Products with 10% APR')).toBe(true);
    expect(isRewardPromo('Airdrop for early adopters')).toBe(true);
    expect(isRewardPromo('Zero-fee trading promotion this week')).toBe(true);
  });

  it('rejects plain listings and product launches', () => {
    expect(isRewardPromo('Goal Difference Futures are now live')).toBe(false);
    expect(isRewardPromo('System maintenance notice')).toBe(false);
    expect(isRewardPromo('New spot trading pairs listed')).toBe(false);
  });
});

describe('isGlobalPromo', () => {
  it('rejects region-locked campaigns', () => {
    expect(isGlobalPromo('[Exclusive Country] Trade Smarter & Earn 5 USDT!')).toBe(false);
    expect(isGlobalPromo('Bonus for selected countries only')).toBe(false);
  });

  it('accepts global campaigns', () => {
    expect(isGlobalPromo('Trade to share up to 100,000 USDT')).toBe(true);
  });
});

describe('isEligiblePromo', () => {
  it('accepts a fresh reward promo', () => {
    expect(isEligiblePromo(promo(), NOW)).toBe(true);
  });

  it('rejects stale promos beyond MAX_PROMO_AGE_H', () => {
    const old = promo({ publishedAt: NOW.getTime() - (MAX_PROMO_AGE_H + 1) * 60 * 60 * 1000 });
    expect(isEligiblePromo(old, NOW)).toBe(false);
  });

  it('rejects campaigns that already ended', () => {
    const ended = promo({ endsAt: NOW.getTime() - 1000 });
    expect(isEligiblePromo(ended, NOW)).toBe(false);
    const live = promo({ endsAt: NOW.getTime() + 86_400_000 });
    expect(isEligiblePromo(live, NOW)).toBe(true);
  });

  it('rejects missing/invalid title or url', () => {
    expect(isEligiblePromo(promo({ title: '' }), NOW)).toBe(false);
    expect(isEligiblePromo(promo({ url: 'http://insecure.example' }), NOW)).toBe(false);
    expect(isEligiblePromo(promo({ url: '' }), NOW)).toBe(false);
  });

  it('rejects non-reward and region-locked titles', () => {
    expect(isEligiblePromo(promo({ title: 'Futures are now live' }), NOW)).toBe(false);
    expect(isEligiblePromo(promo({ title: '[Exclusive Country] Earn 5 USDT bonus' }), NOW)).toBe(false);
  });
});

describe('selectPromo', () => {
  const a = promo({ url: 'https://a.example/1', exchangeSlug: 'bybit', publishedAt: NOW.getTime() - 1000 });
  const b = promo({ url: 'https://b.example/2', exchangeSlug: 'binance', exchangeName: 'Binance', publishedAt: NOW.getTime() - 2000 });

  it('skips already-posted urls', () => {
    expect(selectPromo([a, b], [a.url], null)?.url).toBe(b.url);
  });

  it('rotates away from the last posted exchange when possible', () => {
    expect(selectPromo([a, b], [], 'bybit')?.exchangeSlug).toBe('binance');
  });

  it('falls back to newest unposted when rotation impossible', () => {
    expect(selectPromo([a], [], 'bybit')?.url).toBe(a.url);
  });

  it('returns null when everything was posted', () => {
    expect(selectPromo([a, b], [a.url, b.url], null)).toBeNull();
  });
});
