import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  isPromoSlot,
  promoSlotKey,
  buildPromoCaption,
  promoAutopublishTick,
  POSTED_URLS_CAP,
  isSpotlightDay,
  buildSpotlightCaption,
} from '../services/autopublish/promo';
import { isExchangeStory } from '../services/autopublish/news';
import { looksGeneric, frameOverlaySvg } from '../services/promo-radar/banner';
import { AutopublishStore } from '../services/autopublish';
import { PromoItem } from '../services/promo-radar';

const tmpDirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cbw-promo-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const SLOT_NOW = new Date('2026-06-12T15:30:00Z');

function promo(opts: Partial<PromoItem> = {}): PromoItem {
  return {
    exchangeSlug: opts.exchangeSlug ?? 'bybit',
    exchangeName: opts.exchangeName ?? 'Bybit',
    title: opts.title ?? 'Trade to share up to 100,000 USDT in rewards',
    url: opts.url ?? 'https://announcements.bybit.com/en-US/article/x/',
    publishedAt: opts.publishedAt ?? SLOT_NOW.getTime() - 3_600_000,
    endsAt: opts.endsAt !== undefined ? opts.endsAt : null,
  };
}

const fakeBot = (messageId = 300) => ({
  sendMessage: vi.fn().mockResolvedValue({ message_id: messageId }),
  sendPhoto: vi.fn().mockResolvedValue({ message_id: messageId }),
});

function ctx(opts: {
  enabled?: boolean;
  now?: Date;
  promos?: PromoItem[];
  bot?: ReturnType<typeof fakeBot>;
} = {}) {
  const dir = tmpDir();
  const autopublish = new AutopublishStore('autopublish-state.json', dir);
  if (opts.enabled !== false) autopublish.enable('test');
  return {
    autopublish,
    bot: opts.bot ?? fakeBot(),
    channelId: '@TestChannel',
    now: opts.now ?? SLOT_NOW,
    cardDir: dir,
    collect: async () => opts.promos ?? [promo()],
    banner: false, // no live og:image fetching in tests
  };
}

// ── Slot ─────────────────────────────────────────────────────────────────────

describe('promo slot', () => {
  it('matches 15:30 UTC ±5 min', () => {
    expect(isPromoSlot(new Date('2026-06-12T15:30:00Z'))).toBe(true);
    expect(isPromoSlot(new Date('2026-06-12T15:34:59Z'))).toBe(true);
    expect(isPromoSlot(new Date('2026-06-12T15:25:30Z'))).toBe(true);
    expect(isPromoSlot(new Date('2026-06-12T15:36:00Z'))).toBe(false);
    expect(isPromoSlot(new Date('2026-06-12T13:00:00Z'))).toBe(false);
  });

  it('does not collide with news slots (08/13/18)', () => {
    for (const h of [8, 13, 18]) {
      expect(isPromoSlot(new Date(`2026-06-12T${String(h).padStart(2, '0')}:00:00Z`))).toBe(false);
    }
  });

  it('slot key is unique per UTC day', () => {
    expect(promoSlotKey(SLOT_NOW)).toBe('2026-06-12#promo');
    expect(promoSlotKey(new Date('2026-06-13T15:30:00Z'))).toBe('2026-06-13#promo');
  });
});

// ── Caption ──────────────────────────────────────────────────────────────────

describe('buildPromoCaption', () => {
  it('contains header, title, source link and funnel footer', () => {
    const c = buildPromoCaption(promo(), SLOT_NOW);
    expect(c).toContain('🎁 Bonus Alert — Bybit');
    expect(c).toContain('Trade to share up to 100,000 USDT');
    expect(c).toContain('📰 Official announcement');
    expect(c).toContain('https://announcements.bybit.com');
    expect(c).toContain('https://cryptobonusworld.com/exchanges/bybit/?utm_source=telegram');
  });

  it('shows the deadline when endsAt is known and future', () => {
    const c = buildPromoCaption(promo({ endsAt: Date.UTC(2026, 5, 28) }), SLOT_NOW);
    expect(c).toContain('⏳ Ends 2026-06-28 (UTC)');
  });

  it('omits the deadline when unknown', () => {
    expect(buildPromoCaption(promo(), SLOT_NOW)).not.toContain('⏳');
  });

  it('stays within the 1024-char Telegram caption limit', () => {
    const long = promo({ title: 'Mega promo '.repeat(200) });
    const c = buildPromoCaption(long, SLOT_NOW);
    expect(c.length).toBeLessThanOrEqual(1024);
    expect(c).toContain('…');
    expect(c).toContain('cryptobonusworld.com'); // footer survived the trim
  });
});

// ── Exchange-first pivot (EPIC 025) ─────────────────────────────────────────

describe('isSpotlightDay', () => {
  it('is true only on Sundays (UTC)', () => {
    expect(isSpotlightDay(new Date('2026-06-14T15:30:00Z'))).toBe(true); // Sun
    expect(isSpotlightDay(new Date('2026-06-12T15:30:00Z'))).toBe(false); // Fri
    expect(isSpotlightDay(new Date('2026-06-15T15:30:00Z'))).toBe(false); // Mon
  });
});

describe('buildSpotlightCaption', () => {
  it('promotes the site with UTM and no concrete bonus amounts', () => {
    const c = buildSpotlightCaption();
    expect(c).toContain('cryptobonusworld.com/bonuses/?utm_source=telegram');
    expect(c).not.toMatch(/\$\d/); // honesty: no amounts in ads
    expect(c.length).toBeLessThanOrEqual(1024);
  });
});

describe('isExchangeStory', () => {
  it('matches CBW-listed exchanges', () => {
    expect(isExchangeStory('Bybit launches new copy trading product')).toBe(true);
    expect(isExchangeStory('MEXC announces zero-fee week')).toBe(true);
  });

  it('matches exchange-domain terms and majors without CBW pages', () => {
    expect(isExchangeStory('Coinbase wins court ruling')).toBe(true);
    expect(isExchangeStory('Kraken expands into Europe')).toBe(true);
    expect(isExchangeStory('Major exchange halts withdrawal processing')).toBe(true);
  });

  it('rejects general macro stories', () => {
    expect(isExchangeStory('Bitcoin price hits new all-time high')).toBe(false);
    expect(isExchangeStory('US Senate debates stablecoin bill')).toBe(false);
  });
});

describe('banner helpers', () => {
  it('flags generic logo/placeholder images', () => {
    expect(looksGeneric('https://x.com/assets/logo.png')).toBe(true);
    expect(looksGeneric('https://x.com/og-image-default.jpg')).toBe(true);
    expect(looksGeneric('https://x.com/campaigns/football-2026-banner.jpg')).toBe(false);
  });

  it('frame overlay carries brand elements', () => {
    const svg = frameOverlaySvg();
    expect(svg).toContain('BONUS ALERT');
    expect(svg).toContain('CryptoBonusWorld.com');
    expect(svg).toContain('#E7B53C'); // gold
  });
});

// ── Tick ─────────────────────────────────────────────────────────────────────

describe('promoAutopublishTick', () => {
  it('does nothing when disabled', async () => {
    const r = await promoAutopublishTick(ctx({ enabled: false }) as any);
    expect(r.action).toBe('disabled');
  });

  it('does nothing outside the slot window', async () => {
    const r = await promoAutopublishTick(ctx({ now: new Date('2026-06-12T12:00:00Z') }) as any);
    expect(r.action).toBe('not_time_yet');
  });

  it('publishes one promo and records dedup state', async () => {
    const c = ctx();
    const r = await promoAutopublishTick(c as any);
    expect(r.action).toBe('published');
    expect(c.bot.sendPhoto).toHaveBeenCalledTimes(1);
    const st = c.autopublish.get();
    expect(st.lastPromoSlot).toBe('2026-06-12#promo');
    expect(st.lastPromoExchange).toBe('bybit');
    expect(st.postedPromoUrls).toContain(promo().url);
  });

  it('is idempotent within the slot', async () => {
    const c = ctx();
    await promoAutopublishTick(c as any);
    const r2 = await promoAutopublishTick(c as any);
    expect(r2.action).toBe('already_published_this_slot');
    expect(c.bot.sendPhoto).toHaveBeenCalledTimes(1);
  });

  it('marks the slot even when nothing eligible (no API re-polling)', async () => {
    const c = ctx({ promos: [] });
    const r = await promoAutopublishTick(c as any);
    expect(r.action).toBe('no_eligible_promo');
    expect(c.autopublish.get().lastPromoSlot).toBe('2026-06-12#promo');
  });

  it('never reposts a url already in postedPromoUrls', async () => {
    const c = ctx();
    c.autopublish.updateTick({ postedPromoUrls: [promo().url] });
    const r = await promoAutopublishTick(c as any);
    expect(r.action).toBe('no_eligible_promo');
  });

  it('counts failures toward auto-disable', async () => {
    const bot = fakeBot();
    bot.sendPhoto.mockRejectedValue(new Error('telegram down'));
    const c = ctx({ bot });
    const r = await promoAutopublishTick(c as any);
    expect(r.action).toBe('publish_failed');
    expect(c.autopublish.get().consecutiveFailures).toBe(1);
    expect(c.autopublish.get().lastPromoSlot).toBeNull(); // retry next tick in window
  });

  it('posts the site spotlight on Sundays instead of an exchange promo', async () => {
    const sunday = new Date('2026-06-14T15:30:00Z');
    const c = ctx({ now: sunday });
    const r = await promoAutopublishTick(c as any);
    expect(r.action).toBe('published');
    expect(r.promoUrl).toContain('cryptobonusworld.com/bonuses');
    const caption = c.bot.sendPhoto.mock.calls[0][2].caption as string;
    expect(caption).toContain('CryptoBonusWorld.com');
    expect(c.autopublish.get().lastPromoSlot).toBe('2026-06-14#promo');
  });

  it('caps the dedup list', async () => {
    const c = ctx();
    c.autopublish.updateTick({
      postedPromoUrls: Array.from({ length: POSTED_URLS_CAP }, (_, i) => `https://old.example/${i}`),
    });
    await promoAutopublishTick(c as any);
    expect(c.autopublish.get().postedPromoUrls.length).toBeLessThanOrEqual(POSTED_URLS_CAP);
  });
});
