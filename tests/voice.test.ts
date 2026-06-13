import { describe, it, expect } from 'vitest';
import { hashSeed, newsVoice, promoVoice, bannerLabel } from '../services/autopublish/voice';

describe('voice', () => {
  it('hashSeed is stable and id-sensitive', () => {
    expect(hashSeed('abc')).toBe(hashSeed('abc'));
    expect(hashSeed('abc')).not.toBe(hashSeed('abd'));
  });

  it('newsVoice is deterministic per seed', () => {
    const a = newsVoice(hashSeed('id1'), 'CoinDesk', 'https://x/1', 'Binance lists token');
    const b = newsVoice(hashSeed('id1'), 'CoinDesk', 'https://x/1', 'Binance lists token');
    expect(a).toEqual(b);
  });

  it('newsVoice varies across different posts and always keeps source + link', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const v = newsVoice(hashSeed(`id${i}`), 'CoinDesk', `https://x/${i}`, 'Some market story');
      expect(v.attribution).toContain('CoinDesk');
      expect(v.attribution).toContain(`https://x/${i}`);
      seen.add(`${v.opener}|${v.footer.split('\n')[0]}`);
    }
    expect(seen.size).toBeGreaterThan(3); // genuinely varied
  });

  it('exchange stories route the footer to the exchange page with UTM', () => {
    const v = newsVoice(hashSeed('e'), 'CoinDesk', 'https://x', 'Bybit launches new launchpool');
    expect(v.footer).toContain('cryptobonusworld.com/exchanges/bybit/?utm_source=telegram');
  });

  it('promoVoice is deterministic and keeps the funnel URL', () => {
    const a = promoVoice(hashSeed('u'), 'Bybit', 'bybit', 'https://ann/x', 'https://site/exchanges/bybit/');
    const b = promoVoice(hashSeed('u'), 'Bybit', 'bybit', 'https://ann/x', 'https://site/exchanges/bybit/');
    expect(a).toEqual(b);
    expect(a.footer).toContain('https://site/exchanges/bybit/');
    expect(a.header).toContain('Bybit');
  });

  it('bannerLabel reflects the story type', () => {
    expect(bannerLabel('exchange', 'Binance airdrop for holders', 1)).toBe('AIRDROP');
    expect(bannerLabel('exchange', 'OKX lists new token', 1)).toBe('NEW LISTING');
    expect(bannerLabel('global', 'SEC lawsuit over staking', 1)).toBe('REGULATION');
    expect(bannerLabel('bonus', 'anything', 1)).toBe('BONUS ALERT');
  });
});
