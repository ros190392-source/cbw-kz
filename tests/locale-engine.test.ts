import { describe, it, expect } from 'vitest';
import {
  MT_REVIEW_THRESHOLD,
  aggregateStatus,
  allLocales,
  applyMachineTranslation,
  approveField,
  bestLocale,
  fallbackLocale,
  getLocale,
  isTranslationApproved,
  localeForPost,
  localePerformance,
  newLocalizedContent,
  preferredLocales,
  rejectField,
  resolveLocaleChain,
  supportsLocale,
} from '../services/locale-engine';
import { emptyMetrics } from '../services/analytics-layer';
import { ExchangeRecord, PostAnalyticsRecord } from '../src/types';

function ex(over: Partial<ExchangeRecord> = {}): ExchangeRecord {
  return {
    name: 'Bybit', slug: 'bybit', officialUrl: 'https://x', affiliateUrl: 'https://x',
    supportedGeos: ['*'], restrictedGeos: ['US'], kyc: 'basic', p2p: true, fiat: ['USD'],
    kazakhstan: { available: true, p2p: true, kyc: 'basic', fiat: ['KZT'], notes: '' },
    trustLevel: 'high', notes: '', lastReviewedAt: null,
    ...over,
  };
}

function post(over: Partial<PostAnalyticsRecord> = {}): PostAnalyticsRecord {
  return {
    id: over.id ?? 'p', telegramMessageId: 1, channelId: '@c',
    title: 'T', link: 'https://x', source: 'S',
    category: 'Global', priority: 'MEDIUM', scoreTotal: over.scoreTotal ?? 50,
    exchangeMentions: over.exchangeMentions ?? [],
    geoTags: over.geoTags ?? ['Global'],
    publishedAt: '2026-06-01T00:00:00.000Z',
    metrics: over.metrics ?? emptyMetrics(),
    updatedAt: '2026-06-01T00:00:00.000Z',
  };
}

describe('locale routing + GEO mapping', () => {
  it('preferredLocales maps each target GEO', () => {
    expect(preferredLocales('KZ')).toEqual(['ru-KZ', 'kk-KZ']);
    expect(preferredLocales('DE')).toEqual(['de-DE', 'en-US']);
    expect(preferredLocales('TR')).toEqual(['tr-TR']);
    expect(preferredLocales('IN')).toEqual(['hi-IN', 'en-US']);
    expect(preferredLocales('NG')).toEqual(['en-US']);
  });

  it('unknown country falls back to en-US', () => {
    expect(preferredLocales('ZZ')).toEqual(['en-US']);
  });

  it('all 6 locales are defined', () => {
    expect(allLocales()).toHaveLength(6);
    expect(getLocale('ru-KZ')?.defaultCurrency).toBe('KZT');
  });
});

describe('fallback logic', () => {
  it('fallbackLocale returns the configured fallback', () => {
    expect(fallbackLocale('kk-KZ')).toBe('ru-KZ');
    expect(fallbackLocale('ru-KZ')).toBe('en-US');
    expect(fallbackLocale('en-US')).toBeNull();
  });

  it('resolveLocaleChain walks fallbacks without cycling', () => {
    expect(resolveLocaleChain('kk-KZ')).toEqual(['kk-KZ', 'ru-KZ', 'en-US']);
    expect(resolveLocaleChain('en-US')).toEqual(['en-US']);
    expect(resolveLocaleChain('xx-XX')).toEqual([]);
  });
});

describe('supportsLocale', () => {
  it('true when the exchange operates in the locale country', () => {
    expect(supportsLocale(ex(), 'de-DE')).toBe(true);  // DE allowed
    expect(supportsLocale(ex(), 'ru-KZ')).toBe(true);  // KZ allowed
  });
  it('false for restricted country or unknown locale', () => {
    expect(supportsLocale(ex(), 'en-US')).toBe(false); // US restricted
    expect(supportsLocale(ex(), 'zz-ZZ')).toBe(false);
  });
});

describe('localized content structure', () => {
  it('new content starts fully untranslated with a CTA placeholder', () => {
    const c = newLocalizedContent('news-1', 'de-DE');
    expect(c.status).toBe('untranslated');
    expect(c.cta.text).toBe('{{CTA}}');
    expect(c.title.status).toBe('untranslated');
    expect(aggregateStatus(c)).toBe('untranslated');
  });
});

describe('translation moderation flow', () => {
  it('high-confidence MT → machine_translated; low/none → human_review_required', () => {
    let c = newLocalizedContent('n', 'de-DE');
    c = applyMachineTranslation(c, 'title', 'Titel', MT_REVIEW_THRESHOLD + 10);
    expect(c.title.status).toBe('machine_translated');
    c = applyMachineTranslation(c, 'summary', 'Zusammenfassung', 30);
    expect(c.summary.status).toBe('human_review_required');
    c = applyMachineTranslation(c, 'exchangeNotes', 'Notiz', null);
    expect(c.exchangeNotes.status).toBe('human_review_required');
  });

  it('a bundle is only approved when every field is approved', () => {
    let c = newLocalizedContent('n', 'de-DE');
    for (const f of ['title', 'summary', 'cta'] as const) c = approveField(c, f, 'alice');
    expect(isTranslationApproved(c)).toBe(false); // exchangeNotes still untranslated
    c = approveField(c, 'exchangeNotes', 'alice');
    expect(isTranslationApproved(c)).toBe(true);
  });

  it('any rejected field makes the whole bundle rejected', () => {
    let c = newLocalizedContent('n', 'de-DE');
    c = approveField(c, 'title', 'alice');
    c = rejectField(c, 'summary', 'alice');
    expect(aggregateStatus(c)).toBe('rejected');
  });
});

describe('multi-GEO analytics (Phase 5)', () => {
  it('buckets posts into locales and ranks by engagement', () => {
    const recs = [
      post({ id: 'kz', geoTags: ['KZ'], exchangeMentions: ['bybit'], metrics: { ...emptyMetrics(), reactions: 50, available: true } }),
      post({ id: 'gl', geoTags: ['Global'], metrics: { ...emptyMetrics(), reactions: 1, available: true } }),
    ];
    const perf = localePerformance(recs);
    expect(perf[0].locale).toBe('ru-KZ');     // KZ post wins on engagement
    expect(perf[0].topExchange).toBe('bybit');
    expect(perf.map((p) => p.locale)).toContain('en-US'); // Global → en-US
    expect(bestLocale(recs)?.locale).toBe('ru-KZ');
  });

  it('localeForPost maps GEO tag to a locale', () => {
    expect(localeForPost(post({ geoTags: ['KZ'] }))).toBe('ru-KZ');
    expect(localeForPost(post({ geoTags: ['Global'] }))).toBe('en-US');
  });
});
