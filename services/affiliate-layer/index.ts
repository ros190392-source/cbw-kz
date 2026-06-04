import { AffiliateMeta, BonusRecord, ExchangeRecord } from '../../src/types';

/**
 * Affiliate layer (EPIC 002 · Phase 4).
 *
 * Provides affiliate METADATA, tracking-ready URL building, and CTA *generation
 * helpers*. It deliberately does NOT inject affiliate links into content. CTAs
 * are returned as strings for a human to optionally place during moderation —
 * nothing is auto-appended to drafts or published posts.
 *
 * Pure + deterministic; no I/O, no side effects.
 */

/** Build affiliate metadata from an exchange record. */
export function affiliateMetaFor(
  ex: ExchangeRecord,
  refCode: string | null = null,
  campaign: string | null = null,
): AffiliateMeta {
  return { exchangeSlug: ex.slug, affiliateUrl: ex.affiliateUrl, refCode, campaign };
}

/**
 * Build a tracking-ready URL. Appends `ref`/`utm_campaign` query params only
 * when present; otherwise returns the base affiliate URL untouched. Never
 * fabricates a ref code.
 */
export function buildAffiliateUrl(meta: AffiliateMeta): string {
  const params = new URLSearchParams();
  if (meta.refCode) params.set('ref', meta.refCode);
  if (meta.campaign) params.set('utm_campaign', meta.campaign);
  const qs = params.toString();
  if (!qs) return meta.affiliateUrl;
  return meta.affiliateUrl + (meta.affiliateUrl.includes('?') ? '&' : '?') + qs;
}

export interface CtaOptions {
  refCode?: string | null;
  campaign?: string | null;
  /** Optional bonus to reference in the CTA copy. */
  bonus?: BonusRecord | null;
}

/**
 * Generate a CTA SUGGESTION (plain text) for moderators. This is a helper — the
 * caller decides whether to use it. It is never written into a draft or a
 * published post automatically.
 */
export function buildCta(ex: ExchangeRecord, opts: CtaOptions = {}): string {
  const meta = affiliateMetaFor(ex, opts.refCode ?? null, opts.campaign ?? null);
  const url = buildAffiliateUrl(meta);
  const lead = opts.bonus
    ? `🎁 ${ex.name}: ${opts.bonus.title}`
    : `👉 Trade on ${ex.name}`;
  return `${lead}\n${url}`;
}

/**
 * Flag explaining why this is safe: a single source of truth for the "no
 * auto-injection" rule, importable by callers/tests that want to assert it.
 */
export const AFFILIATE_AUTO_INJECT = false;
