import { describe, it, expect } from 'vitest';
import {
  buildSeo,
  buildWarnings,
  generateDraft,
  generateLocalizedDraft,
  ContentRequest,
} from '../services/content-engine';
import {
  BonusRecord,
  DraftType,
  Evidence,
  ExchangeRecord,
  VerificationClaim,
} from '../src/types';

const NOW = new Date('2026-06-10T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function exch(over: Partial<ExchangeRecord> = {}): ExchangeRecord {
  return {
    name: over.name ?? 'Bybit', slug: over.slug ?? 'bybit', officialUrl: 'https://x', affiliateUrl: 'https://x',
    supportedGeos: ['*'], restrictedGeos: over.restrictedGeos ?? ['US'], kyc: 'basic', p2p: true, fiat: ['USD'],
    kazakhstan: { available: true, p2p: true, kyc: 'basic', fiat: ['KZT', 'Kaspi'], notes: '' },
    trustLevel: 'high', notes: '', lastReviewedAt: null, ...over,
  };
}

function ev(over: Partial<Evidence> = {}): Evidence {
  return {
    id: 'e', sourceUrl: 'https://official', type: over.type ?? 'official_docs', note: '',
    verifiedAt: over.verifiedAt ?? daysAgo(2), expiresAt: null, status: over.status ?? 'verified', reviewer: 'a',
  };
}

function claim(over: Partial<VerificationClaim> = {}): VerificationClaim {
  return {
    id: over.id ?? 'bybit:KZ:p2p', exchangeSlug: 'bybit', country: 'KZ', type: over.type ?? 'p2p',
    assertion: 'true', evidence: over.evidence ?? [], conflicting: false, staleAfterDays: 30,
    lastCheckedAt: 'lastCheckedAt' in over ? over.lastCheckedAt! : null,
  };
}

function bonus(over: Partial<BonusRecord> = {}): BonusRecord {
  return {
    id: over.id ?? 'b', exchangeSlug: 'bybit', type: 'bonus', title: over.title ?? 'New-user rewards',
    description: '', value: null, geos: ['*'], startDate: null, expiryDate: null, sourceUrl: 'https://x',
    verification: over.verification ?? { status: 'unverified', source: '', lastCheckedAt: null },
  };
}

const ALL_TYPES: DraftType[] = ['telegram_post', 'article_outline', 'seo_snippet', 'warning_post', 'educational_post'];
const FORBIDDEN = ['guaranteed', '100%', 'risk-free', 'risk free', 'to the moon', 'guaranteed returns', '1000x', '100x'];

describe('verification-aware warnings', () => {
  it('flags low-confidence and stale claims', () => {
    const w = buildWarnings({ type: 'telegram_post', exchange: exch(), claims: [claim()], geo: 'KZ', now: NOW });
    expect(w.some((x) => /low-confidence/i.test(x))).toBe(true);
    expect(w.some((x) => /re-verify/i.test(x))).toBe(true);
  });

  it('flags an unverified bonus', () => {
    const w = buildWarnings({ type: 'telegram_post', exchange: exch(), bonus: bonus(), claims: [], geo: 'KZ', now: NOW });
    expect(w.some((x) => /unverified/i.test(x))).toBe(true);
  });
});

describe('GEO restriction disclosure', () => {
  it('always discloses restricted GEOs and explicitly warns when targeting one', () => {
    const us = buildWarnings({ type: 'telegram_post', exchange: exch({ restrictedGeos: ['US'] }), claims: [], geo: 'US', now: NOW });
    expect(us.some((x) => x.includes('Not available in: US'))).toBe(true);
    expect(us.some((x) => /RESTRICTED in US/i.test(x))).toBe(true);

    const kz = buildWarnings({ type: 'telegram_post', exchange: exch({ restrictedGeos: ['US'] }), claims: [], geo: 'KZ', now: NOW });
    expect(kz.some((x) => x.includes('Not available in: US'))).toBe(true);
    expect(kz.some((x) => /RESTRICTED in KZ/i.test(x))).toBe(false);
  });
});

describe('SEO structure validity', () => {
  it('produces capped, deduped clusters and a placeholder CTA', () => {
    const seo = buildSeo({ type: 'seo_snippet', exchange: exch(), geo: 'KZ' });
    expect(seo.title.length).toBeLessThanOrEqual(60);
    expect(seo.metaDescription.length).toBeLessThanOrEqual(160);
    expect(seo.ctaPlaceholder).toBe('{{CTA}}');
    for (const cluster of seo.keywordClusters) {
      expect(cluster.length).toBeLessThanOrEqual(5);
      expect(new Set(cluster).size).toBe(cluster.length); // no duplicate stuffing
    }
    expect(seo.faqIdeas.length).toBeGreaterThan(0);
  });

  it('attaches SEO to seo_snippet and article_outline, not telegram_post', () => {
    expect(generateDraft({ type: 'seo_snippet', exchange: exch(), geo: 'KZ' }).seo).not.toBeNull();
    expect(generateDraft({ type: 'article_outline', exchange: exch(), geo: 'KZ' }).seo).not.toBeNull();
    expect(generateDraft({ type: 'telegram_post', exchange: exch(), geo: 'KZ' }).seo).toBeNull();
  });
});

describe('no fake certainty + CTA placeholder rules', () => {
  it('every draft type is machine-generated, review-required, hype-free, with a placeholder CTA', () => {
    for (const type of ALL_TYPES) {
      const d = generateDraft({ type, exchange: exch(), claims: [claim()], geo: 'KZ', now: NOW });
      expect(d.machineGenerated).toBe(true);
      expect(d.humanReviewRequired).toBe(true);
      expect(d.confidenceNote.length).toBeGreaterThan(0);
      expect(d.ctaPlaceholder).toBe('{{CTA}}');
      const text = `${d.title}\n${d.body}`.toLowerCase();
      for (const bad of FORBIDDEN) expect(text).not.toContain(bad);
      expect(d.body).not.toMatch(/https?:\/\//); // no real link injected
    }
  });
});

describe('verification citations', () => {
  it('marks a well-evidenced claim reliable', () => {
    const c = claim({
      id: 'bybit:KZ:p2p', lastCheckedAt: daysAgo(2),
      evidence: [ev({ type: 'official_docs', status: 'verified' }), ev({ id: 'm', type: 'manual_review', status: 'verified' })],
    });
    const d = generateDraft({ type: 'telegram_post', exchange: exch(), claims: [c], geo: 'KZ', now: NOW });
    const cite = d.citations.find((x) => x.target === 'bybit:KZ:p2p')!;
    expect(cite.reliable).toBe(true);
    expect(cite.confidence).toBeGreaterThanOrEqual(60);
  });
});

describe('multilingual draft generation', () => {
  it('produces scaffold variants for each locale, all flagged for human translation', () => {
    const draft = generateDraft({ type: 'telegram_post', exchange: exch(), geo: 'KZ', now: NOW });
    const loc = generateLocalizedDraft(draft, ['ru-KZ', 'kk-KZ', 'en-US', 'de-DE']);
    expect(loc.variants).toHaveLength(4);
    expect(loc.variants.every((v) => v.machineGenerated && v.humanReviewRequired)).toBe(true);
    expect(loc.variants.every((v) => /translation/i.test(v.note))).toBe(true);
    expect(loc.variants.map((v) => v.locale)).toContain('kk-KZ');
  });
});
